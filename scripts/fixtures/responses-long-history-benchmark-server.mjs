#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import process from "node:process";

const FIXTURE_ROOT = process.env.MYCLI_BENCHMARK_ROOT ?? "";

const server = createServer((request, response) => {
	let body = "";
	let bytes = 0;
	let firstByteEpochMilliseconds;
	request.setEncoding("utf8");
	request.on("data", (chunk) => {
		firstByteEpochMilliseconds ??= performance.timeOrigin + performance.now();
		bytes += Buffer.byteLength(chunk);
		body += chunk;
	});
	request.on("end", () => {
		const bodyCompleteEpochMilliseconds = performance.timeOrigin + performance.now();
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			response.writeHead(400).end();
			return;
		}
		const input = Array.isArray(payload.input) ? payload.input : [];
		const inputJson = JSON.stringify(input);
		const kind = payload.max_output_tokens === 600 && !Array.isArray(payload.tools)
			? "compaction_summary"
			: "provider_turn";
		const stats = {
			kind,
			semanticRequestSha256: createHash("sha256")
				.update(JSON.stringify(withoutPromptCacheKeys(payload)))
				.digest("hex"),
			firstByteEpochMilliseconds: firstByteEpochMilliseconds
				?? bodyCompleteEpochMilliseconds,
			bodyCompleteEpochMilliseconds,
			bodyBytes: bytes,
			inputItems: input.length,
			inputTextCharacters: countStrings(input),
			functionCalls: input.filter((item) => item?.type === "function_call").length,
			functionCallOutputs: input.filter(
				(item) => item?.type === "function_call_output",
			).length,
			toolDefinitions: Array.isArray(payload.tools) ? payload.tools.length : 0,
			promptCacheKeyPresent: typeof payload.prompt_cache_key === "string",
			latestCompactionSummaryPresent: inputJson.includes("LATEST_COMPACTION_SUMMARY_MARKER"),
			oldestCompactionSummaryPresent: inputJson.includes("OLDER_COMPACTION_SUMMARY_MARKER_1\n"),
			oldestTurnPresent: inputJson.includes("User request 0:"),
		};
		process.stdout.write(`${JSON.stringify({ type: "request", stats })}\n`);
		body = "";
		payload = undefined;

		const text = kind === "compaction_summary"
			? "Earlier turns contained many completed tool operations. Continue from the retained tail."
			: "Long-history benchmark completed.";
		const responseId = kind === "compaction_summary"
			? "resp_benchmark_summary"
			: "resp_benchmark_turn";
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify({
			type: "response.output_text.delta",
			delta: text,
		})}\n\n`);
		response.write(`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: responseId,
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		})}\n\n`);
		response.end("data: [DONE]\n\n");
	});
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("benchmark_server_address_failed");
	process.stdout.write(`${JSON.stringify({ type: "ready", port: address.port })}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));

function countStrings(value) {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) {
		return value.reduce((total, item) => total + countStrings(item), 0);
	}
	if (!value || typeof value !== "object") return 0;
	return Object.values(value).reduce((total, item) => total + countStrings(item), 0);
}

function withoutPromptCacheKeys(value) {
	if (typeof value === "string" && FIXTURE_ROOT) {
		return value.replaceAll(FIXTURE_ROOT, "<benchmark-root>");
	}
	if (Array.isArray(value)) return value.map(withoutPromptCacheKeys);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
		key === "promptCacheKey" || key === "prompt_cache_key"
			? []
			: [[key, withoutPromptCacheKeys(item)]]
	)));
}
