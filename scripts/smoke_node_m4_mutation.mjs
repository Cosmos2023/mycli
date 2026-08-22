#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { resolveConfig } from "@mycli/config";
import { OpenAIProviderRegistry } from "@mycli/providers";
import { NodeTurnRuntime } from "@mycli/runtime";
import { openRuntimeSessionStore } from "@mycli/storage";
import {
	builtinToolManifest,
	EditTool,
	FileMutationRuntime,
	FileSnapshotStore,
	PatchTool,
	planToolExposure,
	ReadTool,
	ToolRouter,
	WriteTool,
} from "@mycli/tools";

const MAX_OUTPUT_TOKENS = 64;
const TIMEOUT_MS = 45_000;
const SKIP_EXIT_CODE = 77;

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
		writeSummary("unknown", "usage_error", 0, 0, false, false);
		return 64;
	}
	if (values.protocol !== "responses") {
		writeSummary("unknown", "usage_error", 0, 0, false, false);
		return 64;
	}

	const protocol = "responses";
	const homeDir = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	const sessionId = `m4-smoke-${randomUUID()}`;
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
			overrides: { session: sessionId, model: "gpt-5.5" },
		});
	} catch {
		writeSummary(protocol, "failed", 0, 0, false, false);
		return 1;
	}
	if (!config.apiKey) {
		writeSummary(protocol, "skipped", 0, 0, false, false);
		return SKIP_EXIT_CODE;
	}
	if (values["dry-run"]) {
		writeSummary(protocol, "ready", 0, 0, false, false);
		return 0;
	}

	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-m4-smoke-"));
	const dbPath = join(tempRoot, "sessions.db");
	const target = join(tempRoot, "README.md");
	let store;
	try {
		await writeFile(target, "alpha\nbeta\n", "utf8");
		store = openRuntimeSessionStore({ dbPath });
		const exposure = planToolExposure(builtinToolManifest());
		const snapshots = new FileSnapshotStore();
		const mutationRuntime = new FileMutationRuntime({ workspaceRoot: tempRoot, snapshots });
		const toolRouter = new ToolRouter({
			adapters: [
				new ReadTool({ workspaceRoot: tempRoot, snapshots }),
				new EditTool(mutationRuntime),
				new PatchTool(mutationRuntime),
				new WriteTool({ runtime: mutationRuntime }),
			],
			exposure,
		});
		const registry = new OpenAIProviderRegistry();
		const runtimeConfig = {
			...config,
			workspaceRoot: tempRoot,
			protocol,
			model: "gpt-5.5",
			sessionId,
			sessionsDbPath: dbPath,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
			thinkingEnabled: false,
			promptCacheKeyEnabled: false,
		};
		const runtime = new NodeTurnRuntime({
			sessionId,
			workspaceRoot: tempRoot,
			threadId: sessionId,
			instructions: "Read README.md, replace beta with gamma using Edit, then reply exactly OK.",
			store,
			resolveConfig: () => runtimeConfig,
			createProvider: (resolved) => registry.create(resolved),
			createTurnId: randomUUID,
			clock: () => new Date().toISOString(),
			maxOutputTokens: MAX_OUTPUT_TOKENS,
			planTools: () => exposure,
			toolRouter,
		});
		const runtimeEvents = [];
		const result = await runtime.submit({
			clientTurnId: `client-${randomUUID()}`,
			message: "Read README.md at offset 1 with limit 20, replace beta with gamma using Edit, then reply exactly OK.",
			reasoningEffort: "none",
		}, (event) => { runtimeEvents.push(event); }, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const itemTypes = store.loadConversationItems(sessionId).map((item) => item.type);
		const persisted = result.status === "completed"
			&& itemTypes.filter((type) => type === "tool_result").length >= 2
			&& itemTypes.at(-1) === "assistant";
		const fileUpdated = await readFile(target, "utf8") === "alpha\ngamma\n";
		const mutationStart = countMutationEvents(runtimeEvents, "tool_execution_started");
		const mutationComplete = countMutationEvents(runtimeEvents, "tool_execution_completed");
		writeSummary(
			protocol,
			result.status,
			mutationStart,
			mutationComplete,
			persisted,
			fileUpdated,
		);
		return result.status === "completed"
			&& mutationStart >= 1
			&& mutationComplete >= 1
			&& persisted
			&& fileUpdated
			? 0
			: 1;
	} catch {
		writeSummary(protocol, "failed", 0, 0, false, false);
		return 1;
	} finally {
		store?.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function countMutationEvents(events, type) {
	return events.filter((event) =>
		event.type === type && ["Edit", "Patch", "Write"].includes(event.toolName),
	).length;
}

function writeSummary(protocol, status, mutationStart, mutationComplete, persisted, fileUpdated) {
	process.stdout.write(`${JSON.stringify({
		protocol,
		status,
		mutation_start: mutationStart,
		mutation_complete: mutationComplete,
		persisted,
		file_updated: fileUpdated,
		python_started: false,
	})}\n`);
}

process.exitCode = await main();
