#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { resolveConfig } from "@mycli/config";
import { rootAgentPath } from "@mycli/core";
import { SubagentController } from "@mycli/integrations";
import { OpenAIProviderRegistry } from "@mycli/providers";
import {
	AgentSupervisor,
	AgentWorkerPool,
	NodeTurnRuntime,
	WorkerLeasedAgentThreadRuntimeFactory,
} from "@mycli/runtime";
import { openRuntimeSessionStore } from "@mycli/storage";

const SKIP_EXIT_CODE = 77;
const TIMEOUT_MS = 90_000;

async function main() {
	const sourceHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
	let sourceConfig;
	try {
		sourceConfig = await resolveConfig({
			homeDir: sourceHome,
			workspaceRoot: process.cwd(),
			env: { ...process.env, MYCLI_PROTOCOL: "responses" },
			overrides: {
				session: `agent-foreground-config-${randomUUID()}`,
				...(process.env.MYCLI_MODEL?.trim() ? { model: process.env.MYCLI_MODEL.trim() } : {}),
			},
		});
	} catch {
		writeSummary(emptySummary("unavailable", "unknown"));
		return SKIP_EXIT_CODE;
	}
	if (!sourceConfig.apiKey) {
		writeSummary(emptySummary("unavailable", "missing"));
		return SKIP_EXIT_CODE;
	}

	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-node-agent-foreground-smoke-"));
	const homeDir = join(tempRoot, "home");
	const workspaceRoot = join(tempRoot, "workspace");
	const pythonMarker = join(tempRoot, "python-started");
	const dbPath = join(homeDir, ".mycli", "sessions.db");
	const parentSessionId = `agent-foreground-parent-${randomUUID()}`;
	const childSessionId = `agent-foreground-child-${randomUUID()}`;
	let store;
	let pool;
	let controller;
	try {
		await Promise.all([mkdir(homeDir), mkdir(workspaceRoot)]);
		store = openRuntimeSessionStore({ dbPath });
		pool = new AgentWorkerPool({ maxWorkers: 1, maxQueue: 1, warmWorkers: 0 });
		await pool.start();
		const providers = new OpenAIProviderRegistry();
		let workerLeaseObserved = false;
		const delegate = {
			create: async (input) => {
				const runtimeConfig = Object.freeze({
					...sourceConfig,
					homeDir,
					workspaceRoot,
					sessionId: input.childSessionId,
					sessionsDbPath: dbPath,
					protocol: "responses",
					requestMaxRetries: 0,
					streamMaxRetries: 0,
					thinkingEnabled: false,
					promptCacheKeyEnabled: false,
					memoryEnabled: false,
				});
				const runtime = new NodeTurnRuntime({
					sessionId: input.childSessionId,
					workspaceRoot,
					threadId: input.threadId,
					instructions: input.config.instructions.project,
					store,
					modelInputLedger: store.modelInputLedger,
					agentEffectLedger: store.agentEffectLedger,
					resolveConfig: () => runtimeConfig,
					createProvider: (config) => providers.create(config),
					loadLocalImages: () => [],
					createTurnId: randomUUID,
					clock: () => new Date().toISOString(),
					maxOutputTokens: 64,
					planTools: () => [],
					publishLifecycle: () => undefined,
				});
				let activeController;
				return {
					run: async (prompt, signal, emit, turnId) => {
						workerLeaseObserved ||= pool.snapshot().activeLeaseCount === 1;
						activeController = new AbortController();
						const forwardAbort = () => { activeController?.abort(); };
						signal.addEventListener("abort", forwardAbort, { once: true });
						if (signal.aborted) activeController.abort();
						try {
							const turn = await runtime.submit({
								clientTurnId: randomUUID(),
								turnId,
								message: prompt,
								reasoningEffort: "none",
							}, (event) => {
								if (event.type === "turn_completed") {
									emit({ type: "usage", usage: numericUsage(event.usage) });
								}
							}, { signal: activeController.signal });
							return Object.freeze({
								status: childStatus(turn.status),
								report: childReport(turn),
								usage: numericUsage(turn.result?.usage),
							});
						} finally {
							signal.removeEventListener("abort", forwardAbort);
							activeController = undefined;
						}
					},
					bindProviderStepExecutor: (executor) => {
						runtime.bindProviderStepExecutor(executor);
					},
					send: async () => { throw new Error("foreground_agent_not_running"); },
					interrupt: async () => { activeController?.abort(); },
					close: async () => { activeController?.abort(); },
				};
			},
		};
		const runtimeFactory = new WorkerLeasedAgentThreadRuntimeFactory({ pool, delegate });
		controller = new SubagentController({
			createSupervisor: (options) => new AgentSupervisor({
				spawnStore: store.agentSpawns,
				threadStore: store.agentThreads,
				taskStore: store.subagentTasks,
				runtimeFactory,
				...options,
			}),
			parentSessionId,
			parentTurnId: () => "foreground-parent-turn",
			parentTools: () => [],
			resolveSpawnContext: (input) => Object.freeze({
				parentThreadId: input.parentSessionId,
				rootThreadId: input.parentSessionId,
				parentPath: rootAgentPath(),
				config: Object.freeze({
					workspaceRoot,
					cwd: workspaceRoot,
					environment: Object.freeze({}),
					executionPolicy: Object.freeze({
						trusted: true,
						permission: "read-only",
						sandboxMode: "read-only",
						filesystem: "read_only",
						network: "enabled",
						writableRoots: Object.freeze([]),
					}),
					provider: Object.freeze({
						provider: sourceConfig.provider,
						protocol: "responses",
						model: sourceConfig.model,
						reasoningEffort: "none",
					}),
					instructions: Object.freeze({
						project: "Reply exactly FOREGROUND_WORKER_OK without tools.",
					}),
					tools: Object.freeze([]),
					forkTurns: "none",
				}),
			}),
			createTaskId: () => "foreground-smoke-task",
			createChildSessionId: () => childSessionId,
		});
		const result = await withTimeout(
			controller.start({
				prompt: "Reply exactly FOREGROUND_WORKER_OK without tools.",
				mode: "foreground",
			}),
			TIMEOUT_MS,
		);
		const task = store.subagentTasks.get("foreground-smoke-task");
		const manifest = store.modelInputLedger.loadLatestProviderRequestManifest(childSessionId);
		const persisted = task?.status === "completed"
			&& task.payload.mode === "foreground"
			&& typeof task.payload.report === "string"
			&& task.payload.report.includes("FOREGROUND_WORKER_OK")
			&& manifest !== undefined;
		const completed = result.status === "completed"
			&& workerLeaseObserved
			&& persisted
			&& pool.snapshot().activeLeaseCount === 0
			&& !existsSync(pythonMarker);
		writeSummary({
			protocol: "responses",
			status: completed ? "completed" : "failed",
			foreground_completed: result.status === "completed",
			worker_lease_observed: workerLeaseObserved,
			persisted,
			active_lease_count: pool.snapshot().activeLeaseCount,
			python_started: existsSync(pythonMarker),
			credential: "configured",
		});
		return completed ? 0 : 1;
	} catch {
		writeSummary(emptySummary("failed", "configured"));
		return 1;
	} finally {
		await controller?.close().catch(() => undefined);
		await pool?.close().catch(() => undefined);
		store?.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
}

function childStatus(status) {
	return status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
}

function childReport(turn) {
	return typeof turn.result?.assistant_text === "string"
		? turn.result.assistant_text
		: turn.status === "completed" ? "Subagent completed" : "Subagent failed";
}

function numericUsage(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
	return Object.freeze(Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
		typeof item === "number" && Number.isFinite(item) && item >= 0 ? [[key, item]] : []
	))));
}

async function withTimeout(operation, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			operation,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("foreground_smoke_timeout")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function emptySummary(status, credential) {
	return {
		protocol: "responses",
		status,
		foreground_completed: false,
		worker_lease_observed: false,
		persisted: false,
		active_lease_count: 0,
		python_started: false,
		credential,
	};
}

function writeSummary(summary) {
	process.stdout.write(`${JSON.stringify(summary)}\n`);
}

process.exitCode = await main();
