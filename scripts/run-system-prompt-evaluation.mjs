import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { parseProviderRouteId, projectProviderRequest } from "@mycli/core";
import { renderSkillCatalog, SKILL_TOOL_DEFINITION } from "@mycli/integrations";
import {
	READ_TOOL_DEFINITION, SHELL_TOOL_DEFINITION, WRITE_STDIN_TOOL_DEFINITION, WRITE_TOOL_DEFINITION,
} from "@mycli/tools";
import { packagedSystemPrompt } from "../backend/apps/mycli/src/node-runtime/system-prompt.ts";
import { collectTurnContext } from "../backend/packages/runtime/src/context/instruction-context.ts";
import { renderExecutionPolicyContext } from "../backend/packages/runtime/src/context/execution-policy-instructions.ts";

const CORPUS_URL = new URL("../tests/fixtures/system-prompt-evaluation/", import.meta.url);
const TOOLS = [READ_TOOL_DEFINITION, SHELL_TOOL_DEFINITION, WRITE_STDIN_TOOL_DEFINITION,
	WRITE_TOOL_DEFINITION, SKILL_TOOL_DEFINITION];
const { Ajv2020 } = createRequire(import.meta.resolve("@mycli/tools"))("ajv/dist/2020.js");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const VALIDATORS = new Map(TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
const DEFAULT_POLICY = Object.freeze({
	mode: "workspace-write", filesystem: "workspace_write", network: "disabled", writableRoots: ["/workspace"],
});

export async function loadPromptCases(root = CORPUS_URL) {
	const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
	const source = await readFile(new URL("cases.json", root), "utf8");
	const sha256 = createHash("sha256").update(source).digest("hex");
	if (manifest.version !== 1 || manifest.sha256 !== sha256) throw new Error("prompt_evaluation_fixture_drift");
	const corpus = JSON.parse(source);
	if (corpus.version !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length === 0
		|| corpus.cases.length > 16 || new Set(corpus.cases.map((item) => item.id)).size !== corpus.cases.length) {
		throw new Error("prompt_evaluation_corpus_invalid");
	}
	for (const item of corpus.cases) {
		if (!/^[a-z][a-z0-9-]{0,63}$/u.test(item.id) || !Array.isArray(item.items)
			|| !Array.isArray(item.tools) || item.tools.some((name) => !TOOLS.some((tool) => tool.name === name))
			|| !Array.isArray(item.expected?.calls) || item.expected.calls.length === 0) {
			throw new Error("prompt_evaluation_case_invalid");
		}
	}
	return { ...corpus, sha256 };
}

export function promptEvaluationRequest(task, config) {
	const tools = TOOLS.filter((tool) => task.tools.includes(tool.name));
	const policy = task.policy ?? DEFAULT_POLICY;
	const prompt = packagedSystemPrompt();
	const context = collectTurnContext({
		sources: {
			tools, collaborationMode: "default",
			permissionContext: renderExecutionPolicyContext(policy, { trust: "trusted", permission: "workspace" }),
			skillCatalog: renderSkillCatalog({ list: () => task.skills ?? [] }),
			environment: { workspace_root: "/workspace", shell: "zsh", shell_kind: "posix" },
		},
		conversationItems: task.items,
		currentUserRequest: task.items.findLast((item) => item.type === "user")?.text ?? "",
	});
	return projectProviderRequest({
		config: { ...config, maxOutputTokens: 2048, reasoningEffort: "low", cacheRetention: "none", webSearchMode: "disabled" },
		instructions: prompt.content,
		tools,
		history: [
			...context.sections.map((section) => ({
				type: "context", text: section.content,
				metadata: { kind: section.kind, role: section.role, cacheClass: section.cacheClass,
					durability: section.durability, scope: section.scope },
			})),
			...task.items,
		].map((item, index) => item.type === "context" ? {
			...item, metadata: { ...item.metadata, sourceId: `evaluation:${index}`,
				contentSha256: createHash("sha256").update(item.text).digest("hex"), contentLength: item.text.length },
		} : item),
	});
}

export function gradePromptResponse(task, events) {
	const calls = events.filter((event) => event.type === "tool_call");
	const expected = [...task.expected.calls];
	let callsMatch = calls.length === expected.length;
	for (const call of calls) {
		let args;
		try { args = JSON.parse(call.argumentsJson); } catch { callsMatch = false; continue; }
		if (!args || typeof args !== "object" || Array.isArray(args)) { callsMatch = false; continue; }
		if (!task.tools.includes(call.name) || !VALIDATORS.get(call.name)?.(args)) { callsMatch = false; continue; }
		if (call.name === "WriteStdin") args.chars ??= "";
		if (call.name === "Write") args.sandbox_permissions ??= "workspace-write";
		const index = expected.findIndex((wanted) => wanted.name === call.name
			&& Object.entries(wanted.arguments).every(([key, value]) => isDeepStrictEqual(args[key], value)));
		if (index < 0) callsMatch = false;
		else expected.splice(index, 1);
	}
	const text = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
	const firstCall = events.findIndex((event) => event.type === "tool_call");
	const preamble = firstCall < 0 ? "" : events.slice(0, firstCall)
		.filter((event) => event.type === "text_delta").map((event) => event.text).join("").trim();
	const checks = [
		{ id: "completed_response", passed: events.some((event) => event.type === "completed") },
		{ id: "expected_actions", passed: callsMatch && expected.length === 0 },
		...(task.expected.preamble ? [{ id: "preamble_before_tools", passed: preamble.length > 0 }] : []),
		...(task.expected.chinese ? [{ id: "user_language", passed: /\p{Script=Han}/u.test(preamble) }] : []),
		...(task.expected.forbidden_text ? [{ id: "natural_announcement",
			passed: !new RegExp(task.expected.forbidden_text, "iu").test(text) }] : []),
	];
	return { passed: checks.every((check) => check.passed), checks, tool_calls: calls.length };
}

export async function runPromptEvaluation({ cases, provider, config, timeoutMs = 45_000, signal }) {
	const results = [];
	for (const task of cases) {
		if (signal?.aborted) break;
		const started = performance.now();
		const controller = new AbortController();
		const stepSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
		try {
			const events = [];
			let outputChars = 0;
			for await (const event of provider.stream(promptEvaluationRequest(task, config), { signal: stepSignal })) {
				stepSignal.throwIfAborted();
				outputChars += JSON.stringify(event).length;
				if (outputChars > 262_144 || events.length >= 10_000) throw new Error("prompt_evaluation_output_limit");
				events.push(event);
			}
			results.push({ id: task.id, ...gradePromptResponse(task, events), duration_ms: Math.round(performance.now() - started) });
		} catch (error) {
			const { classifyProviderError } = await import("@mycli/providers");
			results.push({ id: task.id, passed: false, checks: [],
				error_code: stepSignal.aborted ? "interrupted_or_timeout"
					: error?.message === "prompt_evaluation_output_limit" ? "output_limit" : classifyProviderError(error).code,
				duration_ms: Math.round(performance.now() - started) });
		} finally { controller.abort(); }
	}
	const prompt = packagedSystemPrompt();
	return { version: 1, prompt_version: prompt.version, prompt_sha256: prompt.contentSha256,
		provider: config.provider, model: config.model, cases: results, total: cases.length,
		passed: results.filter((result) => result.passed).length, interrupted: signal?.aborted === true };
}

export async function main(args = process.argv.slice(2)) {
	const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
		list: { type: "boolean" }, run: { type: "boolean" }, model: { type: "string" },
		case: { type: "string", multiple: true }, timeout: { type: "string", default: "45" },
		help: { type: "boolean", short: "h" },
	} });
	if (values.help) {
		process.stdout.write("Usage: npm run eval:prompt -- [--list]\n       npm run eval:prompt -- --run --model <id> [--case <id>] [--timeout <seconds>]\nLive evaluation uses MYCLI_API_KEY and optional MYCLI_PROVIDER, MYCLI_PROTOCOL, MYCLI_BASE_URL. Tool calls are scored, never executed.\n");
		return 0;
	}
	if (values.run && values.list) throw new Error("prompt_evaluation_mode_conflict");
	const corpus = await loadPromptCases();
	if (values.case?.some((id) => !corpus.cases.some((task) => task.id === id))) throw new Error("prompt_evaluation_case_unknown");
	const cases = corpus.cases.filter((task) => !values.case || values.case.includes(task.id));
	if (!values.run) {
		process.stdout.write(`${JSON.stringify({ version: 1, corpus_sha256: corpus.sha256, cases: cases.map((task) => task.id) }, null, 2)}\n`);
		return 0;
	}
	const timeoutMs = Number(values.timeout) * 1000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error("prompt_evaluation_timeout_invalid");
	if (!process.env.MYCLI_API_KEY) throw new Error("prompt_evaluation_requires_MYCLI_API_KEY");
	const model = values.model ?? process.env.MYCLI_MODEL;
	if (!model) throw new Error("prompt_evaluation_model_required");
	const protocol = process.env.MYCLI_PROTOCOL ?? "responses";
	if (!["responses", "chat_completions", "anthropic_messages"].includes(protocol)) throw new Error("prompt_evaluation_protocol_invalid");
	const config = { provider: parseProviderRouteId(process.env.MYCLI_PROVIDER ?? "openai"), protocol, model };
	const { ProviderRegistry } = await import("@mycli/providers");
	const provider = new ProviderRegistry().create({ ...config,
		apiKey: process.env.MYCLI_API_KEY,
		apiBaseUrl: process.env.MYCLI_BASE_URL ?? (protocol === "anthropic_messages" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"),
		maxOutputTokens: 2048, maxPromptTokens: 32_000, modelContextWindowTokens: 65_536, supportsImages: false,
	});
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		const report = await runPromptEvaluation({ cases, provider, config, timeoutMs, signal: controller.signal });
		process.stdout.write(`${JSON.stringify({ ...report, corpus_sha256: corpus.sha256 }, null, 2)}\n`);
		return report.interrupted ? 130 : report.passed === report.total ? 0 : 1;
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { process.exitCode = await main(); }
	catch { process.stderr.write("prompt_evaluation_failed: check arguments, fixture hashes, and provider configuration\n"); process.exitCode = 2; }
}
