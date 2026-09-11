#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createParser } from "eventsource-parser";
import { resolveConfig } from "@mycli/config";
import { projectProviderRequest } from "@mycli/core";
import { classifyProviderError, ProviderRegistry } from "@mycli/providers";
import { ProviderAgentLoop } from "@mycli/runtime";
import { normalizeProviderAgentLoopFailure } from "../backend/packages/runtime/src/providers/provider-agent-loop.ts";

const FRAME_TYPES = new Set([
	"response.created", "response.in_progress", "response.output_item.added",
	"response.content_part.added", "response.output_text.delta", "response.output_text.done",
	"response.content_part.done", "response.output_item.done", "response.completed",
	"response.incomplete", "response.failed", "response.function_call_arguments.delta",
	"response.function_call_arguments.done", "response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
	"response.reasoning_summary_part.done", "error",
]);
const MAX_RECORDS = 4096;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 1024;
const TIMEOUT_MS = 45_000;
const TOOL = Object.freeze({
	id: "probe-value", name: "ProbeValue", description: "Return the fixed diagnostic value.",
	inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
});
const REVIEW_TOOL = Object.freeze({ ...TOOL, id: "read-fixture", name: "ReadFixture", description: "Read the synthetic code fixture." });
const REVIEW_FIXTURE = [
	"01 async function transfer(db, sender, recipient, amount) {",
	"02   const balance = await db.balance(sender);",
	"03   if (amount <= 0 || balance < amount) throw new Error('invalid');",
	"04   await db.transaction(async (tx) => {",
	"05     await tx.setBalance(sender, balance - amount);",
	"06     await tx.incrementBalance(recipient, amount);",
	"07   });",
	"08   await sendReceipt(sender, recipient, amount);",
	"09 }",
	"10 // Separate concurrent calls can use the same sender.",
	"11 // Transactions atomically commit their writes with READ COMMITTED isolation.",
].join("\n");

function boundedPush(rows, row) {
	if (rows.length < MAX_RECORDS) rows.push(row);
}

// Measure demand and read completion separately, without prefetching or tee buffering.
export function observeFetchReads(baseFetch, evidence, now) {
	return async (input, init) => {
		const transport = { started_ms: now(), reads: [], frames: [], bytes: 0, parse_ms: 0 };
		evidence.transports.push(transport);
		if (typeof init?.body === "string") {
			transport.request_body_bytes = Buffer.byteLength(init.body);
			if (transport.request_body_bytes <= MAX_BODY_BYTES) {
				try {
					const request = JSON.parse(init.body);
					transport.request_field_bytes = {};
					for (const name of ["instructions", "input", "tools", "messages"]) {
						if (request[name] !== undefined) {
							transport.request_field_bytes[name] = Buffer.byteLength(JSON.stringify(request[name]));
						}
					}
				} catch { /* Field sizes are optional diagnostic evidence. */ }
			}
		}
		const response = await baseFetch(input, init);
		transport.headers_ms = now();
		transport.status = response.status;
		for (const name of ["x-request-id", "request-id", "x-oai-request-id"]) {
			const value = response.headers.get(name);
			if (value && /^[a-zA-Z0-9:_-]{1,256}$/u.test(value)) {
				transport.request_id = value;
				break;
			}
		}
		if (!response.ok || !response.body
			|| !response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		const parser = createParser({
			maxBufferSize: MAX_BODY_BYTES,
			onEvent(event) {
				let type = "other";
				let terminal;
				try {
					const value = JSON.parse(event.data);
					if (FRAME_TYPES.has(value?.type)) type = value.type;
					if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
						const fieldBytes = {};
						for (const name of ["instructions", "tools", "output", "usage", "metadata", "reasoning"]) {
							if (value.response?.[name] !== undefined) {
								fieldBytes[name] = Buffer.byteLength(JSON.stringify(value.response[name]));
							}
						}
						terminal = { data_bytes: Buffer.byteLength(event.data), response_field_bytes: fieldBytes };
					}
				} catch { /* The actual provider adapter owns protocol validation. */ }
				boundedPush(transport.frames, { type, at_ms: now(), read: transport.reads.length - 1, ...terminal });
			},
		});
		let stopped = false;
		let previousReadEnd = transport.headers_ms;
		const cancel = (reason) => {
			stopped = true;
			const pending = reader.cancel(reason);
			reader.releaseLock();
			return pending;
		};
		const body = new ReadableStream({
			async pull(controller) {
				const row = { requested_ms: now() };
				row.consumer_idle_ms = row.requested_ms - previousReadEnd;
				boundedPush(transport.reads, row);
				try {
					const chunk = await reader.read();
					row.resolved_ms = now();
					row.wait_ms = row.resolved_ms - row.requested_ms;
					previousReadEnd = row.resolved_ms;
					if (stopped) return;
					if (chunk.done) {
						stopped = true;
						transport.eof_ms = now();
						controller.close();
						reader.releaseLock();
						return;
					}
					row.bytes = chunk.value.byteLength;
					transport.bytes += row.bytes;
					if (transport.bytes > MAX_BODY_BYTES) throw new Error("probe_body_limit");
					const parseStart = performance.now();
					parser.feed(decoder.decode(chunk.value, { stream: true }));
					transport.parse_ms += performance.now() - parseStart;
					controller.enqueue(chunk.value);
				} catch (error) {
					if (stopped) return;
					controller.error(error);
					void cancel(error).catch(() => undefined);
				}
			},
			cancel(reason) {
				transport.cancel_ms = now();
				return cancel(reason);
			},
		}, { highWaterMark: 0 });
		const observed = new Response(body, {
			status: response.status, statusText: response.statusText, headers: response.headers,
		});
		Object.defineProperties(observed, {
			url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
		});
		return observed;
	};
}

function summarizeStep(evidence) {
	const frames = evidence.transports.flatMap((transport) => transport.frames);
	const lastText = frames.findLast((frame) => frame.type === "response.output_text.delta");
	const terminal = frames.find((frame) => frame.type === "response.completed"
		|| frame.type === "response.incomplete" || frame.type === "response.failed" || frame.type === "error");
	const reads = evidence.transports.flatMap((transport) => transport.reads);
	const tailReads = lastText && terminal
		? reads.filter((read) => read.resolved_ms > lastText.at_ms && read.requested_ms < terminal.at_ms)
		: [];
	return {
		run: evidence.run, step: evidence.step, success: evidence.success,
		request_body_bytes: evidence.transports[0]?.request_body_bytes,
		request_field_bytes: evidence.transports[0]?.request_field_bytes,
		elapsed_ms: evidence.elapsed_ms,
		...(lastText && terminal ? { raw_text_tail_ms: terminal.at_ms - lastText.at_ms } : {}),
		...(terminal ? { terminal_to_return_ms: evidence.elapsed_ms - terminal.at_ms } : {}),
		...(terminal?.data_bytes ? { terminal_data_bytes: terminal.data_bytes, terminal_field_bytes: terminal.response_field_bytes } : {}),
		tail_read_wait_ms: tailReads.reduce((sum, read) => sum + (read.wait_ms ?? 0), 0),
		max_tail_consumer_idle_ms: Math.max(0, ...tailReads.map((read) => read.consumer_idle_ms)),
		parse_ms: evidence.transports.reduce((sum, transport) => sum + transport.parse_ms, 0),
		event_loop_max_ms: evidence.event_loop_max_ms,
		tool_calls: evidence.tool_calls, usage: evidence.usage,
		...(evidence.failure_code ? { failure_code: evidence.failure_code } : {}),
	};
}

export async function runLatencyProbe(config, options, report) {
	const withTool = options.scenario !== "text";
	const tool = options.scenario === "review" ? REVIEW_TOOL : TOOL;
	for (let run = 1; run <= options.runs; run += 1) {
		const sessionId = `latency-probe-${randomUUID()}`;
		const history = [{
			type: "user",
			text: options.scenario === "review"
				? "Call ReadFixture exactly once. Identify the most consequential bug in the fixture and a concrete fix. Reply in at most 60 words with relevant line numbers."
				: withTool
					? "Call ProbeValue exactly once, then reply with exactly: Probe complete: value is <value>."
					: "Reply with exactly: Probe complete.",
		}];
		const steps = withTool ? 2 : 1;
		for (let step = 1; step <= steps; step += 1) {
			const evidence = { run, step, started_at: new Date().toISOString(), transports: [], events: [] };
			report.steps.push(evidence);
			const started = performance.now();
			const now = () => performance.now() - started;
			const delay = monitorEventLoopDelay({ resolution: 10 });
			delay.enable();
			const signal = AbortSignal.timeout(TIMEOUT_MS);
			let result;
			try {
				const provider = new ProviderRegistry({ fetch: observeFetchReads(globalThis.fetch, evidence, now) })
					.create({ ...config, maxOutputTokens: MAX_OUTPUT_TOKENS });
				result = await new ProviderAgentLoop().runStep({
					provider,
					request: projectProviderRequest({
						config: {
							provider: config.provider, protocol: config.protocol, model: config.model,
							reasoningEffort: config.reasoningEffort, sessionId, cacheRetention: "none",
							maxOutputTokens: MAX_OUTPUT_TOKENS, webSearchMode: "disabled",
						},
						instructions: "Complete this bounded diagnostic task. Do not perform any other actions.",
						history, tools: withTool ? [tool] : [],
					}),
					requestMaxRetries: 0, maxRetries: 0, signal, toolCallsAllowed: step < steps,
					emit: (event) => boundedPush(evidence.events, { type: event.type, at_ms: now() }),
					recordDiagnostic: (diagnostic) => { evidence.diagnostic = diagnostic; },
					normalizeFailure: (error) => normalizeProviderAgentLoopFailure(error, signal),
				});
			} finally {
				evidence.elapsed_ms = now();
				delay.disable();
				evidence.event_loop_max_ms = delay.max / 1e6;
			}
			evidence.success = !("failure" in result);
			if ("failure" in result) evidence.failure_code = result.failure.code;
			else {
				evidence.usage = result.usage;
				evidence.tool_calls = result.toolCalls.length;
				evidence.text_bytes = Buffer.byteLength(result.assistantText);
			}
			evidence.summary = summarizeStep(evidence);
			process.stdout.write(`${JSON.stringify(evidence.summary)}\n`);
			if ("failure" in result) return false;
			if (step === steps) {
				if (!result.assistantText.trim()) return false;
				continue;
			}
			if (result.toolCalls.length !== 1 || result.toolCalls[0].name !== tool.name
				|| Object.keys(JSON.parse(result.toolCalls[0].argumentsJson)).length !== 0) return false;
			history.push({
				type: "assistant_tool_calls", text: result.assistantText, calls: result.toolCalls,
				...(result.providerState ? { providerState: result.providerState } : {}),
				...(result.responseId ? { responseId: result.responseId } : {}),
			}, {
				type: "tool_result", callId: result.toolCalls[0].callId,
				toolName: tool.name, output: options.scenario === "review" ? REVIEW_FIXTURE : "7", success: true,
			});
		}
	}
	return true;
}

async function main() {
	const { values } = parseArgs({ options: {
		runs: { type: "string", default: "1" }, scenario: { type: "string", default: "tool" },
		help: { type: "boolean", short: "h", default: false },
	} });
	if (values.help) {
		process.stdout.write("Usage: node --conditions=mycli-source --import tsx scripts/probe_provider_latency.mjs [--runs 1|2] [--scenario tool|text|review]\nUses configured credentials for at most four live requests; no session storage or user files.\n");
		return;
	}
	if (!["1", "2"].includes(values.runs) || !["tool", "text", "review"].includes(values.scenario)) {
		throw new Error("invalid_probe_options");
	}
	const config = await resolveConfig({ homeDir: homedir(), workspaceRoot: process.cwd(), env: process.env });
	if (config.protocol !== "responses") throw new Error("probe_requires_responses_protocol");
	const directory = await mkdtemp(join(tmpdir(), "mycli-latency-probe-"));
	const evidencePath = join(directory, "evidence.json");
	const report = {
		version: 1, provider: config.provider, protocol: config.protocol, model: config.model,
		reasoning: config.reasoningEffort, scenario: values.scenario,
		max_output_tokens: MAX_OUTPUT_TOKENS, timeout_ms: TIMEOUT_MS, steps: [],
	};
	process.stdout.write(`${JSON.stringify({ event: "probe_started", model: report.model, reasoning: report.reasoning, scenario: report.scenario })}\n`);
	try {
		report.success = await runLatencyProbe(config, { runs: Number(values.runs), scenario: values.scenario }, report);
	} finally {
		await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		process.stdout.write(`${JSON.stringify({ evidence: evidencePath, success: report.success ?? false })}\n`);
	}
	if (!report.success) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${JSON.stringify({ error_code: classifyProviderError(error).code })}\n`);
		process.exitCode = 1;
	});
}
