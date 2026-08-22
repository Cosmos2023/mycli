#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { resolveConfig } from "@mycli/config";
import { OpenAIProviderRegistry } from "@mycli/providers";
import { NodeTurnRuntime } from "@mycli/runtime";
import { openRuntimeSessionStore } from "@mycli/storage";

const MAX_OUTPUT_TOKENS = 64;
const TIMEOUT_MS = 45_000;
const SKIP_EXIT_CODE = 77;
const PROTOCOLS = new Set(["responses", "chat_completions"]);

const HELP = `Usage: node scripts/smoke_node_m2.mjs --protocol <protocol> [--dry-run]

Options:
  --protocol <protocol>  responses or chat_completions
  --dry-run              Validate configuration without calling a provider
  -h, --help             Show help
`;

async function main() {
	let values;
	try {
		({ values } = parseArgs({
			options: {
				protocol: { type: "string" },
				"dry-run": { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		process.stderr.write("smoke_usage_error: use --protocol responses|chat_completions\n");
		return 64;
	}
	if (values.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const protocol = values.protocol;
	if (typeof protocol !== "string" || !PROTOCOLS.has(protocol)) {
		process.stderr.write("smoke_usage_error: use --protocol responses|chat_completions\n");
		return 64;
	}

	const homeDir = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	const workspaceRoot = process.cwd();
	const sessionId = `m2-smoke-${randomUUID()}`;
	const boundedEnv = {
		...process.env,
		MYCLI_PROTOCOL: protocol,
		MYCLI_REQUEST_MAX_RETRIES: "0",
		MYCLI_STREAM_MAX_RETRIES: "0",
		MYCLI_PROMPT_CACHE_KEY_ENABLED: "false",
	};
	let config;
	try {
		config = await resolveConfig({
			homeDir,
			workspaceRoot,
			env: boundedEnv,
			overrides: { session: sessionId },
		});
	} catch {
		writeSummary({
			protocol,
			status: "failed",
			event_counts: {},
			persisted: false,
			credential: "unknown",
		});
		return 1;
	}
	if (!config.apiKey) {
		writeSummary({
			protocol,
			status: "skipped",
			event_counts: {},
			persisted: false,
			credential: "missing",
		});
		return SKIP_EXIT_CODE;
	}
	if (values["dry-run"]) {
		writeSummary({
			protocol,
			status: "ready",
			event_counts: {},
			persisted: false,
			credential: "configured",
		});
		return 0;
	}

	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-m2-smoke-"));
	const dbPath = join(tempRoot, "sessions.db");
	let store;
	try {
		store = openRuntimeSessionStore({ dbPath });
		const registry = new OpenAIProviderRegistry();
		const runtimeConfig = {
			...config,
			protocol,
			sessionId,
			sessionsDbPath: dbPath,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
			thinkingEnabled: false,
			promptCacheKeyEnabled: false,
		};
		const runtime = new NodeTurnRuntime({
			sessionId,
			workspaceRoot,
			threadId: sessionId,
			instructions: "You are mycli. Complete this bounded smoke request without tools.",
			store,
			resolveConfig: () => runtimeConfig,
			createProvider: (resolved) => registry.create(resolved),
			createTurnId: randomUUID,
			clock: () => new Date().toISOString(),
			maxOutputTokens: MAX_OUTPUT_TOKENS,
		});
		const events = [];
		const clientTurnId = `client-${randomUUID()}`;
		const result = await runtime.submit({
			clientTurnId,
			message: "Reply with exactly OK and no other text.",
			reasoningEffort: "none",
		}, (event) => { events.push(event); }, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const stored = store.loadTurn(sessionId, clientTurnId);
		const conversation = store.loadConversation(sessionId);
		const persisted = stored?.status === "completed"
			&& conversation.some((message) => message.role === "assistant" && message.content.length > 0);
		writeSummary({
			protocol,
			status: result.status,
			event_counts: eventCounts(events),
			persisted,
			credential: "configured",
			...(result.error_code ? { error_code: result.error_code } : {}),
		});
		return result.status === "completed" && persisted ? 0 : 1;
	} catch {
		writeSummary({
			protocol,
			status: "failed",
			event_counts: {},
			persisted: false,
			credential: "configured",
		});
		return 1;
	} finally {
		store?.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function eventCounts(events) {
	const counts = {};
	for (const event of events) {
		let key;
		if (event.type === "reasoning_delta") key = "reasoning_delta";
		if (event.type === "text_delta") key = "text_delta";
		if (event.type === "turn_completed") key = "completed";
		if (key) counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

function writeSummary(summary) {
	process.stdout.write(`${JSON.stringify(summary)}\n`);
}

process.exitCode = await main();
