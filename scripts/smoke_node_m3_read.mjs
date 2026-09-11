#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { resolveConfig } from "@mycli/config";
import { ProviderRegistry } from "@mycli/providers";
import { NodeTurnRuntime } from "@mycli/runtime";
import { openRuntimeSessionStore } from "@mycli/storage";
import {
	builtinToolManifest,
	planToolExposure,
	ReadTool,
	ToolRouter,
} from "@mycli/tools";

const MAX_OUTPUT_TOKENS = 64;
const TIMEOUT_MS = 45_000;
const SKIP_EXIT_CODE = 77;
const PROTOCOLS = new Set(["responses", "chat_completions"]);

async function main() {
	let values;
	try {
		({ values } = parseArgs({
			options: {
				protocol: { type: "string", default: "responses" },
				"dry-run": { type: "boolean", default: false },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		writeSummary("unknown", "usage_error", 0, 0, false);
		return 64;
	}
	const protocol = values.protocol;
	if (typeof protocol !== "string" || !PROTOCOLS.has(protocol)) {
		writeSummary("unknown", "usage_error", 0, 0, false);
		return 64;
	}

	const homeDir = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	const sessionId = `m3-smoke-${randomUUID()}`;
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
			workspaceRoot: process.cwd(),
			env: boundedEnv,
			overrides: { session: sessionId },
		});
	} catch {
		writeSummary(protocol, "failed", 0, 0, false);
		return 1;
	}
	if (!config.apiKey) {
		writeSummary(protocol, "skipped", 0, 0, false);
		return SKIP_EXIT_CODE;
	}
	if (values["dry-run"]) {
		writeSummary(protocol, "ready", 0, 0, false);
		return 0;
	}

	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-m3-smoke-"));
	const dbPath = join(tempRoot, "sessions.db");
	let store;
	try {
		await writeFile(join(tempRoot, "README.md"), "alpha\nbeta\n", "utf8");
		store = openRuntimeSessionStore({ dbPath });
		const exposure = planToolExposure(builtinToolManifest());
		const readTool = new ReadTool({ workspaceRoot: tempRoot });
		const toolRouter = new ToolRouter({ adapters: [readTool], exposure });
		const registry = new ProviderRegistry();
		const runtimeConfig = {
			...config,
			workspaceRoot: tempRoot,
			protocol,
			sessionId,
			sessionsDbPath: dbPath,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
			thinkingEnabled: false,
			cacheRetention: "none",
		};
		const runtime = new NodeTurnRuntime({
			sessionId,
			workspaceRoot: tempRoot,
			threadId: sessionId,
			instructions: "Use Read on README.md, then answer with exactly OK.",
			store,
			resolveConfig: () => runtimeConfig,
			createProvider: (resolved) => registry.create(resolved),
			createTurnId: randomUUID,
			clock: () => new Date().toISOString(),
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			planTools: () => exposure,
			toolRouter,
		});
		const events = [];
		const clientTurnId = `client-${randomUUID()}`;
		const result = await runtime.submit({
			clientTurnId,
			message: "Read README.md with offset 1 and limit 2, then reply with exactly OK.",
			reasoningEffort: "none",
		}, (event) => { events.push(event); }, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const itemTypes = store.loadConversationItems(sessionId).map((item) => item.type);
		const persisted = result.status === "completed"
			&& itemTypes.includes("assistant_tool_calls")
			&& itemTypes.includes("tool_result")
			&& itemTypes.at(-1) === "assistant";
		writeSummary(
			protocol,
			result.status,
			countEvents(events, "tool_execution_started"),
			countEvents(events, "tool_execution_completed"),
			persisted,
		);
		return result.status === "completed" && persisted ? 0 : 1;
	} catch {
		writeSummary(protocol, "failed", 0, 0, false);
		return 1;
	} finally {
		store?.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function countEvents(events, type) {
	return events.filter((event) => event.type === type).length;
}

function writeSummary(protocol, status, toolStart, toolComplete, persisted) {
	process.stdout.write(`${JSON.stringify({
		protocol,
		status,
		tool_start: toolStart,
		tool_complete: toolComplete,
		persisted,
		python_started: false,
	})}\n`);
}

process.exitCode = await main();
