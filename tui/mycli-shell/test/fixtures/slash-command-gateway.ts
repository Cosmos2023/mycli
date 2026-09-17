import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { mock } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import { createErrorContext, errorSummary, gatewayContractCatalog, slashCommandArguments } from "@mycli/contracts";
import { MycliShellRuntime } from "../../src/application/shell-runtime.ts";
import { configureGatewayTransport } from "../../src/transport/gateway-transport.ts";
import { TtyOpenError } from "../../src/platform/tty-terminal.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

interface Request {
	readonly id: string;
	readonly method: string;
	readonly params: Record<string, unknown>;
}

const terminal = new HeadlessTerminal({ rows: 32, columns: 110 });
mock.module(new URL("../../src/platform/tty-terminal.ts", import.meta.url).href, {
	namedExports: {
		TtyOpenError,
		openTtyStreams: () => ({ close: (): void => {} }),
		StreamTerminal: function (): HeadlessTerminal { return terminal; },
	},
});
let mountedRuntime: MycliShellRuntime | undefined;
const originalStart = MycliShellRuntime.prototype.start;
mock.method(MycliShellRuntime.prototype, "start", function (this: MycliShellRuntime): void {
	mountedRuntime = this;
	originalStart.call(this);
});

const input = new PassThrough();
const output = new PassThrough();
const lines = createInterface({ input: output });
const requests: Request[] = [];
const heldHistory: Request[] = [];
let compactRequest: Request | undefined;
let rejectSettingsLoad = process.env.MYCLI_TEST_SETTINGS_ERROR === "1";
let activeSession = "initial";
let generation = 1;
let pluginEnabled = false;
let extensionVersion = 1;
let savedViewMode = "default";
let rejectNextClear = true;
const sessions = [{ id: "initial", title: "Initial session", cwd: "/tmp" }];
const commands = ["new", "resume", "clear", "view", "settings", "compact", "export"].map((id) => ({
	id, name: `/${id}`, description: `Run ${id}`, argument_policy: "optional", available_during_turn: false,
}));

function notify(method: string, params: Record<string, unknown>): void {
	input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function respond(request: Request, result: Record<string, unknown>): void {
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}

function activate(sessionId: string): Record<string, unknown> {
	activeSession = sessionId;
	generation += 1;
	if (!sessions.some((session) => session.id === sessionId)) sessions.push({ id: sessionId, title: sessionId, cwd: "/tmp" });
	notify("session.changed", { session_id: activeSession, generation });
	return { mutated_session: true, session_id: activeSession, generation, lines: [`Session ${sessionId}`] };
}

function runCommand(request: Request): void {
	const command = String(request.params.command);
	if (slashCommandArguments(command, "/export") !== null) {
		assert.equal(request.params.session_id, activeSession);
		assert.equal(request.params.generation, generation);
		respond(request, { execution: "backend", presentation: "transcript", result_id: `export:${request.id}`,
			display: { version: 1, kind: "diagnostic", command, title: "Conversation exported", severity: "info",
				fields: [{ label: "File", value: "/tmp/training data.jsonl" }, { label: "Messages", value: "12" },
					{ label: "Tool calls", value: "2" }, { label: "Tool results", value: "2" },
					{ label: "Reasoning blocks", value: "1" }, { label: "Redactions", value: "4" }],
				rows: [], sections: [], suggestions: [], omitted_rows: 0, omitted_chars: 0 },
		});
		return;
	}
	if (command === "/compact") { compactRequest = request; return; }
	const target = slashCommandArguments(command, "/resume");
	if (command === "/clear" && rejectNextClear) {
		rejectNextClear = false;
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id,
			error: { code: "turn_in_progress", message: "Session transition is busy." },
		})}\n`);
	} else if (command === "/new" || command === "/clear") {
		respond(request, activate(`fresh-${generation}`));
	} else if (target) {
		const result = activate(target);
		if (target === "waiting") notify("approval.request", {
			session_id: target, generation, turn_id: "turn-waiting", client_turn_id: "client-waiting",
			decision_id: "restored-approval", preview: "Run tests",
			options: [{ choice: "approve_once", label: "Approve once" }],
		});
		respond(request, result);
	} else if (command === "/plugin:fixture:ping") {
		respond(request, { lines: ["Plugin ran"] });
	} else if (slashCommandArguments(command, "/tasks") !== null) {
		const message = "/tasks has been removed. Use /agents instead.";
		const errorContext = createErrorContext({
			reason: "gateway.invalid_request", source: "gateway",
			scope: { kind: "request", id: request.id },
			outcome: { state: "not_started", effects: "none" },
		});
		const data = { additional_details: message, error_context: errorContext, occurrence_id: errorContext.id };
		notify("gateway.error", { code: "invalid_arguments", message: errorSummary(errorContext), method: "command.run", ...data });
		input.write(`${JSON.stringify({
			jsonrpc: "2.0", id: request.id,
			error: { code: "invalid_arguments", message: errorSummary(errorContext), data },
		})}\n`);
	} else {
		const id = command.trim().split(/\s+/u)[0]!.slice(1);
		const action = { view: "set_view_mode", resume: "open_session_selector", settings: "open_settings" }[id];
		assert.ok(action, `Unexpected fixture command: ${command}`);
		respond(request, { execution: "tui", command_id: id, client_action: action, args: slashCommandArguments(command, `/${id}`) ?? "" });
	}
}

lines.on("line", (line: string) => {
	const request = JSON.parse(line) as Request;
	requests.push(request);
	switch (request.method) {
		case "extension.manifest":
			respond(request, {
				schema_version: 1,
				rpc_methods: gatewayContractCatalog.rpcMethods.map((name) => ({ name })),
				event_streams: gatewayContractCatalog.eventStreams.map((name) => ({ name })),
			});
			break;
		case "session.bootstrap":
			respond(request, {
				protocol_version: 1, session_id: activeSession, generation, workspace: "/tmp", provider: "fixture", model: "fixture",
				trust: { state: "trusted" }, status: { session_id: activeSession, generation, turn_running: false },
			});
			break;
		case "transcript.load":
			if (request.params.session_id === "delayed") { heldHistory.push(request); break; }
			respond(request, {
				session_id: request.params.session_id, next_before: null,
				items: request.params.session_id === "initial" ? [{ id: "saved", type: "assistant_final", text: "Saved answer", folded: false, metadata: {} }] : [],
			});
			break;
		case "command.list": {
			const plugin = { id: "plugin", name: "/plugin:fixture:ping", description: "Ping plugin", argument_policy: "optional", available_during_turn: true };
			const catalog = [...commands, ...(pluginEnabled ? [plugin] : [])];
			respond(request, { commands: catalog, routing_names: [...catalog.map((command) => command.name), "/tasks"] });
			break;
		}
		case "settings.load":
			if (rejectSettingsLoad) {
				rejectSettingsLoad = false;
				input.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "config_error", message: "Private configuration parse detail" } })}\n`);
			} else respond(request, { settings: { view_mode: savedViewMode } });
			break;
		case "settings.save":
			assert.equal(request.params.setting_id, "tui.view_mode");
			savedViewMode = String(request.params.value);
			respond(request, { ok: true, settings: { view_mode: savedViewMode } });
			break;
		case "session.list": respond(request, { sessions }); break;
		case "resource.list": respond(request, { resources: [] }); break;
		case "command.run": runCommand(request); break;
		case "turn.interrupt": {
			assert.ok(compactRequest);
			assert.equal(request.params.operation_id, compactRequest.params.operation_id);
			respond(request, { accepted: true, requested: true });
			const params = { session_id: activeSession, generation, checkpoint_id: request.params.operation_id,
				client_turn_id: request.params.operation_id, source: "user_requested", before_tokens: 900, max_tokens: 1000 };
			notify("compaction.completed", { ...params, status: "interrupted", after_tokens: 900, duration_s: 1 });
			respond(compactRequest, { lifecycle_started: true });
			compactRequest = undefined;
			break;
		}
		case "shutdown": respond(request, { ok: true }); break;
		default: assert.fail(`Unexpected gateway request: ${request.method}`);
	}
});
configureGatewayTransport({ input, output, close: () => { lines.close(); input.destroy(); output.destroy(); } });

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Slash command fixture timed out");
		await setTimeout(5);
	}
}

async function refreshExtensions(): Promise<void> {
	const before = requests.filter((request) => request.method === "command.list").length;
	notify("extension.updated", { version: ++extensionVersion });
	await waitFor(() => requests.filter((request) => request.method === "command.list").length > before);
	await setImmediate();
}

const gateway = await import("../../src/application/gateway-session.ts");
try {
	notify("runtime.ready", { session_id: activeSession });
	await gateway.gatewayStartup;
	assert.ok(mountedRuntime);
	if (process.env.MYCLI_TEST_SETTINGS_ERROR === "1") {
		assert.equal(mountedRuntime.getState().messages.filter((message) => message.text.includes("Could not load saved interface settings")).length, 1);
		assert.doesNotMatch(mountedRuntime.ui.render(110).join("\n"), /Private configuration parse detail/);
	}
	const runtime = mountedRuntime;
	const submit = (command: string): void => { runtime.editor.onSubmit?.(command); };

	runtime.showCommandPalette();
	terminal.sendInput("export");
	assert.match(runtime.ui.render(110).join("\n"), /\/export/);
	assert.doesNotMatch(runtime.ui.render(110).join("\n"), /--training|--output/);
	terminal.sendInput("\x1b");
	submit("/export");
	await waitFor(() => runtime.ui.render(110).join("\n").includes("Conversation exported"));
	assert.equal(runtime.getState().sessionId, "initial");
	for (const width of [60, 80, 110]) {
		const text = runtime.ui.render(width).join("\n");
		assert.match(text, /training data\.jsonl/);
		assert.match(text, /Tool results/);
		assert.match(text, /Messages/);
		assert.match(text, /Tool calls/);
		assert.equal(text.match(/Conversation exported/gu)?.length, 1);
	}
	assert.equal(requests.filter((request) => request.method === "command.run" && String(request.params.command).startsWith("/export")).length, 1);
	assert.equal(requests.some((request) => request.method === "turn.submit"), false);

	runtime.showCommandPalette();
	terminal.sendInput("tasks");
	assert.doesNotMatch(runtime.ui.render(110).join("\n"), /\/tasks/);
	terminal.sendInput("\x1b");
	submit("/tasks");
	await waitFor(() => runtime.ui.render(110).join("\n").includes("Use /agents instead."));
	await setImmediate();
	assert.equal(runtime.ui.render(110).join("\n").match(/Use \/agents instead\./gu)?.length, 1);
	assert.equal(requests.filter((request) => request.method === "command.run" && request.params.command === "/tasks").length, 1);
	assert.equal(requests.some((request) => request.method === "turn.submit"), false);
	assert.equal(runtime.editor.getText(), "/tasks");
	runtime.editor.setText("");

	submit("/clear");
	await waitFor(() => requests.some((request) => request.method === "command.run" && request.params.command === "/clear"));
	await setImmediate();
	assert.equal(runtime.getState().sessionId, "initial");
	assert.equal(runtime.getState().messages.some((message) => message.text === "Saved answer"), true,
		"failed clear must retain the visible history and its session");
	submit("/clear");
	await waitFor(() => runtime.getState().sessionId === "fresh-1" && runtime.getState().transcript?.length === 0);
	assert.equal(activeSession, "fresh-1", "clear must also reset the backend model context");
	await refreshExtensions();
	assert.equal(runtime.getState().transcript?.length, 0, "refresh must not restore cleared history");

	submit("/view\tfocus");
	await waitFor(() => runtime.getState().settings?.viewMode === "focus");
	await refreshExtensions();
	assert.equal(runtime.getState().settings?.viewMode, "focus");
	submit("/settings");
	await waitFor(() => runtime.ui.render(110).join("\n").includes("Settings"));
	assert.equal(runtime.getState().settings?.viewMode, "focus", "settings reload must preserve the local view mode");
	terminal.sendInput("view");
	terminal.sendInput("\r");
	assert.match(runtime.ui.render(110).join("\n"), /Choose View mode/);
	terminal.sendInput("\x1b[A");
	terminal.sendInput("\r");
	terminal.sendInput("\r");
	await waitFor(() => runtime.getState().settings?.viewMode === "verbose");
	await refreshExtensions();
	assert.equal(runtime.getState().settings?.viewMode, "verbose", "refresh must preserve the view mode chosen in settings");
	terminal.sendInput("\x1b");
	submit("/settings");
	await waitFor(() => runtime.ui.render(110).join("\n").includes("Settings"));
	assert.equal(runtime.getState().settings?.viewMode, "verbose", "settings must replace the earlier slash-command view override");
	terminal.sendInput("view");
	terminal.sendInput("\r");
	terminal.sendInput("\x1b[A");
	terminal.sendInput("\r");
	terminal.sendInput("\x1b[B");
	terminal.sendInput("\r");
	await waitFor(() => requests.some((request) => request.method === "settings.save")
		&& runtime.ui.render(110).join("\n").includes("Settings"));
	assert.equal(savedViewMode, "default");
	assert.equal(runtime.getState().settings?.viewMode, "default", "saving a user default must replace the session view override");
	await refreshExtensions();
	assert.equal(runtime.getState().settings?.viewMode, "default");
	assert.equal(requests.filter((request) => request.method === "settings.save").length, 1, "session choices must not persist user defaults");
	terminal.sendInput("\x1b");

	submit("/new");
	await waitFor(() => runtime.getState().sessionId === "fresh-2" && runtime.getState().sessions?.some((session) => session.id === "fresh-2") === true);
	const listRequests = requests.filter((request) => request.method === "session.list").length;
	submit("/resume");
	await waitFor(() => requests.filter((request) => request.method === "session.list").length > listRequests);
	await setImmediate();
	assert.match(runtime.ui.render(110).join("\n"), /fresh-2/);
	terminal.sendInput("\x1b");

	pluginEnabled = true;
	runtime.showCommandPalette();
	await refreshExtensions();
	assert.match(runtime.ui.render(110).join("\n"), /\/plugin:fixture:ping/);
	terminal.sendInput("\x1b");
	submit("/plugin:fixture:ping");
	await waitFor(() => requests.some((request) => request.method === "command.run" && request.params.command === "/plugin:fixture:ping"));
	assert.equal(requests.some((request) => request.method === "turn.submit"), false);

	submit("/resume delayed");
	await waitFor(() => heldHistory.length === 1);
	submit("/new");
	await waitFor(() => runtime.getState().sessionId === "fresh-4");
	respond(heldHistory.shift()!, { session_id: "delayed", next_before: null, items: [] });
	await setImmediate();
	assert.equal(runtime.getState().sessionId, "fresh-4", "old history must not replace the newest session");
	assert.equal(activeSession, "fresh-4");

	for (const key of ["\x1b", "\x03"]) {
		const interrupts = requests.filter((request) => request.method === "turn.interrupt").length;
		submit("/compact");
		await waitFor(() => compactRequest !== undefined);
		assert.equal(runtime.getState().footer.turnRunning, false);
		assert.equal(runtime.getState().footer.operationRunning, true);
		assert.match(runtime.ui.render(110).join("\n"), /Compacting context/);
		notify("compaction.started", { session_id: activeSession, generation, checkpoint_id: compactRequest!.params.operation_id,
			client_turn_id: compactRequest!.params.operation_id, source: "user_requested", before_tokens: 900, max_tokens: 1000 });
		await setImmediate();
		terminal.sendInput(key);
		await waitFor(() => requests.filter((request) => request.method === "turn.interrupt").length > interrupts && runtime.getState().footer.operationRunning === false);
		assert.doesNotMatch(runtime.ui.render(110).join("\n"), /Press Ctrl\+C again|Worked|Turn interrupted/);
	}

	submit("/resume waiting");
	await waitFor(() => runtime.getState().transcript?.some((block) => block.kind === "message" && block.message.text === "Session waiting") === true);
	assert.equal(runtime.getState().pendingApproval?.decisionId, "restored-approval");
	assert.match(runtime.ui.render(110).join("\n"), /Approve once/);
	process.stdout.write("slash-command-gateway: passed\n");
} finally {
	await mountedRuntime?.shutdown();
	await gateway.gatewayShutdown();
	await terminal.flush();
	terminal.dispose();
	mock.restoreAll();
}
