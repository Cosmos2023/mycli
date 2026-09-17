import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { resolveConfig } from "@mycli/config";
import { GatewayClient } from "@mycli/gateway";
import type { ProviderEvent, ProviderRequest } from "@mycli/core";
import { NodeTurnRuntime } from "@mycli/runtime";
import type { SessionTrainingConversation } from "@mycli/runtime";
import { openRuntimeSessionStore } from "@mycli/storage";
import { parseCliMode } from "../src/management/parser.ts";
import { createDefaultManagementServices } from "../src/management/services.ts";
import { renderManagementResponse } from "../src/management/render.ts";
import { TrainingExportError, writeTrainingExportFile } from "../src/node-runtime/session-training-export.ts";
import type { SessionManagementResponse } from "../src/management/session.ts";
import { startTestNodeBackend } from "./support/offline-update-fetch.ts";

test("CLI and slash training export share one complete runtime conversation without provider access", async (t) => {
	const root = await temporaryRoot(t);
	const workspaceRoot = join(root, "workspace");
	const homeDir = join(root, "home");
	await mkdir(workspaceRoot);
	await mkdir(homeDir);
	const config = await resolveConfig({ workspaceRoot, homeDir, env: {}, overrides: { session: "training-session", provider: "openai", protocol: "responses", model: "gpt-test" } });
	const store = openRuntimeSessionStore({ dbPath: config.sessionsDbPath, reconcileRuntimeState: false });
	t.after(() => store.close());
	const requests: ProviderRequest[] = [];
	const content = "begin\n" + "line of content\n".repeat(490) + "end";
	const runtime = new NodeTurnRuntime({
		sessionId: config.sessionId, threadId: config.sessionId, workspaceRoot, instructions: "Original training system prompt.",
		modelInputLedger: store.modelInputLedger, agentEffectLedger: store.agentEffectLedger, store,
		resolveConfig: () => config, createProvider: () => ({ stream: async function* (request): AsyncIterable<ProviderEvent> {
			requests.push(request);
			if (requests.length === 1) {
				yield { type: "text_delta", text: "Read the input file." };
				yield { type: "tool_call", callId: "provider-read", name: "Read", argumentsJson: JSON.stringify({ file_path: join(workspaceRoot, "file.ts"), api_key: "synthetic-key" }) };
			} else yield { type: "text_delta", text: "Completed using the stored tool output." };
			yield { type: "provider_state", state: { provider: "openai", value: { thinkingBlocks: [{ thinking: "Stored thought.", thinkingSignature: "excluded-reasoning" }] } } };
			yield { type: "completed", responseId: `response-${requests.length}` };
		} }),
		loadLocalImages: () => [], createTurnId: () => "training-turn", clock: () => new Date().toISOString(), publishLifecycle: () => undefined,
		planTools: () => [{ id: "Read", name: "Read", description: "Read input.", inputSchema: { type: "object", properties: { file_path: { type: "string" }, api_key: { type: "string" } } } }],
		toolRouter: { execute: async (call) => ({ callId: call.callId, toolName: call.name, success: true, summary: "short preview", modelOutput: content, metadata: {} }) },
	});
	const turn = await runtime.submit({ clientTurnId: "client-training", clientUserMessageId: "user-training", message: "Read input and finish." }, () => undefined, { signal: new AbortController().signal });
	assert.equal(turn.status, "completed", JSON.stringify(turn));
	assert.equal(requests.length, 2);
	store.close();
	const services = await createDefaultManagementServices({ workspaceRoot, homeDir, env: {} });
	const parsed = parseCliMode(["session", "export", config.sessionId, "--training", "--output", "training data.jsonl", "--json"]);
	assert.equal(parsed.kind, "management");
	if (parsed.kind !== "management") return;
	const response = await services.execute(parsed.command) as SessionManagementResponse;
	assert.equal(response.ok, true, JSON.stringify(response));
	assert.equal(response.trainingExport?.report.tool_calls, 1, JSON.stringify(response));
	assert.equal(requests.length, 2);
	const output = join(workspaceRoot, "training data.jsonl");
	const raw = await readFile(output, "utf8");
	assert.equal(raw.trimEnd().split("\n").length, 1);
	const conversation = JSON.parse(raw) as SessionTrainingConversation;
	assert.equal(conversation.messages[0]?.content, "Original training system prompt.");
	assert.equal(conversation.messages.filter((message) => message.role === "system").length, 1);
	assert.equal(conversation.messages.filter((message) => message.role === "tool").length, 1);
	assert.equal(conversation.messages.find((message) => message.role === "tool")?.content, content);
	assert.equal(conversation.messages.filter((message) => message.role === "assistant").length, 2);
	assert.equal(conversation.tools.length, 1);
	assert.doesNotMatch(raw, /synthetic-key|excluded-reasoning|short preview/u);
	assert.ok(raw.includes("Stored thought."));
	assert.equal(raw.includes(workspaceRoot), false);
	assert.ok(raw.includes("[WORKSPACE]"));
	assert.equal(response.trainingExport?.report.bytes_written, Buffer.byteLength(raw));
	assert.ok((response.trainingExport?.report.redactions ?? 0) > 0);
	assert.deepEqual(JSON.parse(renderManagementResponse(parsed.command, response)), response);
	assert.match(renderManagementResponse({ ...parsed.command, json: false }, response), /tool_calls=1/u);
	assert.equal(JSON.stringify(response).includes(content), false);
	if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
	const repeat = await services.execute(parsed.command);
	assert.deepEqual(repeat.issues, ["training_export_exists"]);
	assert.equal(await readFile(output, "utf8"), raw);
	assert.deepEqual((await readdir(workspaceRoot)).filter((name) => name.startsWith(".mycli-training-")), []);

	const backend = await startTestNodeBackend({ cwd: workspaceRoot,
		args: ["--session", config.sessionId, "--model", "gpt-test"],
		env: { HOME: homeDir, MYCLI_PROVIDER: "openai", MYCLI_PROTOCOL: "responses",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1", MYCLI_API_KEY: "synthetic-key", MYCLI_AGENT_EXECUTION_ADAPTER: "worker" },
	});
	const client = new GatewayClient({ ...backend.transport });
	client.start();
	t.after(async () => { await backend.close(); client.stop(); });
	await client.request("session.bootstrap", { protocol_version: 1 });
	const catalog = await client.request("command.list", { surface: "tui" });
	assert.equal(catalog.commands.find((command) => command.name === "/export")?.available, true);
	const statusBefore = await client.request("status.get", {});
	const exported = await client.request("command.run", { surface: "tui", session_id: config.sessionId,
		command: "/export",
	});
	assert.match(JSON.stringify(exported), /Conversation exported/);
	const automaticPath = exportedFilePath(exported);
	assert.equal(dirname(automaticPath), workspaceRoot);
	assert.match(basename(automaticPath), /^session-[\dTZ-]+-[a-f0-9]{8}\.jsonl$/u);
	const slashRaw = await readFile(automaticPath, "utf8");
	assert.deepEqual(JSON.parse(slashRaw), conversation);
	assert.equal(JSON.stringify(exported).includes(content), false);
	assert.equal((await client.request("status.get", {})).session_id, statusBefore.session_id);
	const repeated = await client.request("command.run", { surface: "tui", command: "/export" });
	const repeatedPath = exportedFilePath(repeated);
	assert.notEqual(repeatedPath, automaticPath);
	assert.equal(dirname(repeatedPath), workspaceRoot);
	assert.equal(await readFile(repeatedPath, "utf8"), slashRaw);
	assert.equal(await readFile(automaticPath, "utf8"), slashRaw);
	const explicit = await client.request("command.run", { surface: "tui", command: '/export --training --output "slash training.jsonl"' });
	assert.equal(exportedFilePath(explicit), join(workspaceRoot, "slash training.jsonl"));
	const collision = await client.request("command.run", { surface: "tui", command: '/export --training --output "slash training.jsonl"' });
	assert.match(JSON.stringify(collision), /Output already exists/);
	assert.equal(await readFile(join(workspaceRoot, "slash training.jsonl"), "utf8"), slashRaw);
	assert.equal(requests.length, 2);
	const retired = await client.request("command.run", { surface: "tui", command: '/export --training --samples-only --output filtered.jsonl' });
	assert.match(JSON.stringify(retired), /Use \/export/);
	assert.equal((await readdir(workspaceRoot)).includes("filtered.jsonl"), false);
	await client.request("session.new", {});
	const empty = await client.request("command.run", { surface: "tui", command: "/export" });
	assert.match(JSON.stringify(empty), /Conversation exported/);
	assert.deepEqual(JSON.parse(await readFile(exportedFilePath(empty), "utf8")).messages, []);
});

test("atomic export protects files and symlinks, including a destination created during writing", async (t) => {
	const root = await temporaryRoot(t);
	const destination = join(root, "data.jsonl");
	await writeFile(destination, "existing data");
	await assert.rejects(writeTrainingExportFile(destination, async () => assert.fail("existing destination must fail before export"), new AbortController().signal), exportCode("training_export_exists"));
	assert.equal(await readFile(destination, "utf8"), "existing data");
	if (process.platform !== "win32") {
		const symbolic = join(root, "symlink.jsonl");
		await symlink(destination, symbolic);
		await assert.rejects(writeTrainingExportFile(symbolic, async () => undefined, new AbortController().signal), exportCode("training_export_exists"));
		const dangling = join(root, "dangling.jsonl");
		await symlink(join(root, "missing"), dangling);
		await assert.rejects(writeTrainingExportFile(dangling, async () => undefined, new AbortController().signal), exportCode("training_export_exists"));
	}
	const race = join(root, "race.jsonl");
	await assert.rejects(writeTrainingExportFile(race, async (writeLine) => {
		await writeLine('{"sample":1}\n');
		await writeFile(race, "concurrently created");
	}, new AbortController().signal), exportCode("training_export_exists"));
	assert.equal(await readFile(race, "utf8"), "concurrently created");
	assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".mycli-training-")), []);
});

test("failed and cancelled exports clean partial files without disclosing source exceptions", async (t) => {
	const root = await temporaryRoot(t);
	const failed = join(root, "failed.jsonl");
	await assert.rejects(writeTrainingExportFile(failed, async (writeLine) => {
		await writeLine('{"partial":true}\n');
		throw new Error("private command and credential");
	}, new AbortController().signal), (error: unknown) => {
		assert.ok(error instanceof TrainingExportError);
		assert.equal(error.code, "training_export_failed");
		assert.doesNotMatch(error.message, /private command|credential/u);
		return true;
	});
	for (const before of [true, false]) {
		const controller = new AbortController();
		if (before) controller.abort("private abort reason");
		await assert.rejects(writeTrainingExportFile(join(root, "cancelled.jsonl"), async (writeLine) => {
			await writeLine('{"partial":true}\n');
			controller.abort("private abort reason");
		}, controller.signal), exportCode("training_export_cancelled"));
	}
	assert.deepEqual(await readdir(root), []);
});

async function temporaryRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mycli-training-export-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function exportCode(code: TrainingExportError["code"]): (error: unknown) => boolean {
	return (error) => error instanceof TrainingExportError && error.code === code;
}

function exportedFilePath(result: unknown): string {
	const display = (result as { display: { fields: { label: string; value: string }[] } }).display;
	const outputPath = display.fields.find((field) => field.label === "File")?.value;
	assert.ok(outputPath, "Export must report its output path.");
	return outputPath;
}
