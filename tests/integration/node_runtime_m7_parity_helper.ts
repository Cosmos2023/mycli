import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import process from "node:process";
import { resolveConfig } from "../../packages/config/src/index.ts";
import {
	discoverHookConfig,
	discoverMcpConfig,
	discoverPlugins,
	SkillRegistry,
	SubagentProfileRegistry,
} from "../../packages/integrations/src/index.ts";
import { SQLiteSessionStore } from "../../packages/storage/src/index.ts";
import { doctorResponseFromReport } from "../../apps/mycli/src/management/doctor/runner.ts";
import { renderManagementResponse } from "../../apps/mycli/src/management/render.ts";

type JsonObject = Record<string, unknown>;

interface Command extends JsonObject {
	readonly action: "collect" | "write_task";
	readonly home?: string;
	readonly workspace?: string;
	readonly builtin?: string;
	readonly management?: string;
	readonly extensions: string;
	readonly db_path?: string;
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
	if (!line.trim()) continue;
	const command = parseCommand(JSON.parse(line) as unknown);
	const result = command.action === "collect"
		? await collect(command)
		: await writeTask(command);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function collect(command: Command): Promise<JsonObject> {
	const home = requiredString(command.home, "home");
	const workspace = requiredString(command.workspace, "workspace");
	const builtin = requiredString(command.builtin, "builtin");
	const management = await readJson(requiredString(command.management, "management"));
	const configInput = recordValue(management.config);
	const config = await resolveConfig({
		homeDir: home,
		workspaceRoot: workspace,
		env: stringRecord(configInput.env),
		overrides: {
			session: "m7-parity",
			model: requiredString(configInput.cli_model, "cli_model"),
		},
	});
	const skills = await SkillRegistry.discover({
		builtinRoot: builtin,
		userRoot: `${home}/.mycli/skills`,
		sharedRepoRoot: `${workspace}/.agents/skills`,
		repoRoot: `${workspace}/.mycli/skills`,
	});
	const profiles = await SubagentProfileRegistry.discover({ homeDir: home, workspaceRoot: workspace });
	const hooks = await discoverHookConfig({ homeDir: home, workspaceRoot: workspace });
	const mcp = await discoverMcpConfig({ homeDir: home, workspaceRoot: workspace, env: {} });
	const plugins = await discoverPlugins({ homeDir: home, workspaceRoot: workspace });
	const doctorInput = recordValue(management.doctor);
	const checks = arrayValue(doctorInput.checks).map((value) => {
		const item = recordValue(value);
		const detail = optionalString(item.detail);
		return Object.freeze({
			name: requiredString(item.name, "doctor check name"),
			status: doctorStatus(item.status),
			message: requiredString(item.message, "doctor check message"),
			...(detail ? { detail } : {}),
		});
	});
	const report = Object.freeze({
		checks: Object.freeze(checks),
		okCount: checks.filter((item) => item.status === "ok").length,
		warningCount: checks.filter((item) => item.status === "warning").length,
		failedCount: checks.filter((item) => item.status === "failed").length,
	});
	const response = doctorResponseFromReport(report);
	return {
		config: {
			provider: config.provider,
			protocol: config.protocol,
			model: config.model,
			api_base_url: config.apiBaseUrl,
			auth_ref: config.authRef,
			request_max_retries: config.requestMaxRetries,
			stream_max_retries: config.streamMaxRetries,
			thinking_enabled: config.thinkingEnabled,
		},
		skills: skills.list().map((item) => ({ name: item.name, source: item.sourceKind })),
		profiles: profiles.records()
			.filter((item) => item.id === "parity-agent")
			.map((item) => ({
				id: item.id,
				source: item.sourceKind,
				status: item.status,
				allowed_tools: [...(item.profile?.allowedTools ?? [])],
				budget: { ...(item.profile?.budget ?? {}) },
			})),
		hooks: hooks.hooks.map((item) => ({
			id: item.hookId,
			source: item.scope,
			point: item.hookPoint,
			enabled: item.enabled,
			timeout_ms: item.timeoutMs,
			working_directory: item.workingDirectory,
			environment: item.envPolicy,
		})),
		mcp: mcp.servers.map((item) => ({
			id: item.id,
			transport: item.transport,
			enabled: item.enabled,
			timeout_ms: item.timeoutMs,
		})),
		python_plugins: plugins.migrations.map((item) => ({
			id: item.pluginId,
			status: item.kind,
		})),
		management: {
			response,
			human: renderManagementResponse({ kind: "doctor", json: false }, response),
			json: renderManagementResponse({ kind: "doctor", json: true }, response),
		},
	};
}

async function writeTask(command: Command): Promise<JsonObject> {
	const fixture = await readJson(command.extensions);
	const expected = recordValue(recordValue(fixture.expected).node_task);
	const store = new SQLiteSessionStore({
		dbPath: requiredString(command.db_path, "db_path"),
		clock: () => "2026-08-06T00:00:00.000Z",
	});
	try {
		const ownership = {
			taskId: requiredString(expected.task_id, "task_id"),
			parentSessionId: requiredString(expected.parent_session_id, "parent_session_id"),
			childSessionId: requiredString(expected.child_session_id, "child_session_id"),
		};
		store.subagentTasks.reserve({
			...ownership,
			parentTurnId: requiredString(expected.parent_turn_id, "parent_turn_id"),
			profileId: requiredString(expected.profile_id, "profile_id"),
		});
		store.subagentTasks.markRunning(ownership);
		const task = store.subagentTasks.complete({
			...ownership,
			report: requiredString(expected.report, "report"),
		});
		return {
			task_id: task.taskId,
			parent_session_id: task.parentSessionId,
			parent_turn_id: task.parentTurnId,
			child_session_id: task.childSessionId,
			profile_id: task.profileId,
			status: task.status,
			report: task.payload.report,
		};
	} finally {
		store.close();
	}
}

function parseCommand(value: unknown): Command {
	const command = recordValue(value);
	if (command.action !== "collect" && command.action !== "write_task") {
		throw new Error("invalid M7 parity helper action");
	}
	return command as Command;
}

async function readJson(path: string): Promise<JsonObject> {
	return recordValue(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function recordValue(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected object");
	}
	return value as JsonObject;
}

function arrayValue(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error("expected array");
	return value;
}

function stringRecord(value: unknown): Record<string, string> {
	const record = recordValue(value);
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [
		key,
		requiredString(item, key),
	]));
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function doctorStatus(value: unknown): "ok" | "warning" | "failed" {
	if (value !== "ok" && value !== "warning" && value !== "failed") {
		throw new Error("invalid doctor status");
	}
	return value;
}
