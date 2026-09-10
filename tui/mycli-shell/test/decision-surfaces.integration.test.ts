import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
	initialRuntimeState,
} from "../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../src/state/runtime-event-reducer.ts";
import {
	runtimeStateAfterSessionResume,
} from "../src/state/session-state.ts";
import type { MycliShellPermissionState, MycliShellState } from "../src/model.ts";
import {
	MycliShellRuntime,
} from "../src/application/shell-runtime.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

function permissionState(): MycliShellPermissionState {
	return {
		active: "workspace",
		commandAllowanceCount: 2,
		effective: {
			trusted: true, valid: true, sandboxMode: "workspace-write", filesystem: "workspace_write",
			network: "disabled", approvalBehavior: "on-request", source: "session", constrained: false,
			readableRoots: 1, writableRoots: 1, networkDomains: 0, sessionGrant: false, turnGrant: false,
		},
		sandboxReadiness: { state: "ready", code: "ready", platform: "darwin", isolation: "macos_seatbelt" },
		profiles: [
			{
				id: "workspace", label: "Ask for approval", current: true,
				description: "Read and edit the current workspace; ask before network or outside access.",
				filesystem: "workspace_write", network: "disabled", approvalBehavior: "on-request",
			},
			{
				id: "full-access", label: "Full Access", current: false,
				description: "Access files and network without approval.",
				filesystem: "unrestricted", network: "enabled", approvalBehavior: "never",
			},
			{
				id: "read-only", label: "Read Only", current: false,
				description: "Read workspace files; ask before edits or network.",
				filesystem: "read_only", network: "disabled", approvalBehavior: "on-request",
			},
		],
	};
}

function initialState(): MycliShellState {
	return {
		messages: [{ id: "request", role: "user", text: "Prepare a report." }],
		tools: [], bash: [],
		footer: { cwd: "/workspace/demo", sessionName: "decision-test", liveState: "Idle", trust: "trusted" },
		permissions: permissionState(),
	};
}

async function flush(terminal: HeadlessTerminal): Promise<void> {
	await delay(35);
	await terminal.flush();
}

test("live and restored shell approvals render the model reason from gateway events", async () => {
	const modelReason = "\u662f\u5426\u5141\u8bb8\u6211\u53ea\u8bfb\u67e5\u770b /Library/LaunchDaemons \u7684\u5143\u6570\u636e\uff1f";
	for (const nativeScrollback of [false, true]) {
		for (const resumed of [false, true]) {
			let state = reduceRuntimeEvent(initialRuntimeState(), "session.changed", { session_id: "shell-reason" });
			state = reduceRuntimeEvent(state, "status.changed", {
				session_id: "shell-reason", generation: 1,
				turn_running: false, pending_decision: true, suspended_turn: true,
			});
			state = reduceRuntimeEvent(state, "approval.request", {
				session_id: "shell-reason", generation: 1, decision_id: "reason-approval",
				tool_name: "Shell", preview: "Shell stat requires approval",
				command_preview: "stat /Library/LaunchDaemons",
				reason: "This command requests broader permissions than currently allowed.",
				justification: modelReason,
				options: [{ choice: "approve_once", label: "Allow once" }, { choice: "reject", label: "Reject" }],
			});
			if (resumed) state = runtimeStateAfterSessionResume(state, "shell-reason", "Shell reason", {
				session_id: "shell-reason", generation: 1,
			});
			const terminal = new HeadlessTerminal({ columns: 100, rows: 24, nativeScrollback });
			const runtime = new MycliShellRuntime({
				initialState: { ...projectRuntimeState(state), settings: { reducedMotion: true } }, terminal,
			});
			try {
				runtime.start();
				await flush(terminal);
				const output = terminal.visibleLines().join("\n");
				assert.ok(output.includes(`Reason: ${modelReason}`), output);
				assert.match(output, /\$ stat \/Library\/LaunchDaemons/u);
				assert.match(output, /1\. Allow once/u);
				assert.match(output, /2\. Reject/u);
				assert.doesNotMatch(output, /This command requests broader permissions|Approval:/u);
			} finally {
				await runtime.shutdown();
				await terminal.flush();
				terminal.dispose();
			}
		}
	}
});

test("permission panels preserve their title, selection and footer across terminal sizes", async (context) => {
	for (const nativeScrollback of [false, true]) {
		const terminal = new HeadlessTerminal({ columns: 80, rows: 24, nativeScrollback });
		const runtime = new MycliShellRuntime({ initialState: initialState(), terminal });
		context.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
		runtime.start();
		runtime.showPermissionSelector();
		for (const [width, height] of [[80, 24], [40, 24], [32, 12], [120, 24]] as const) {
			terminal.resize(width, height);
			await delay(120);
			await terminal.flush();
			const lines = terminal.visibleLines();
			const output = lines.join("\n");
			assert.match(output, /Update Model Permissions/);
			assert.match(output, /\u203a 1\. Ask for approval/u);
			assert.match(output, /enter confirm/);
			assert.match(output, /esc back/);
			assert.ok(runtime.ui.render(width).length <= height, output);
		}
	}
});

test("long approvals retain their decisions alongside activity and queued inputs", async (context) => {
	const terminal = new HeadlessTerminal({ columns: 40, rows: 24, nativeScrollback: true });
	const state = initialState();
	state.pendingApproval = {
		decisionId: "long-approval", toolName: "request_permissions", preview: "Read report sources",
		reason: "Compare the source documents before producing a report.",
		permissionRequest: {
			network: false,
			readPaths: Array.from({ length: 40 }, (_, index) => `/workspace/report-${index + 1}.txt`),
			writePaths: [],
		},
		options: [{ choice: "approve_once", label: "Allow once" }, { choice: "reject", label: "Reject" }],
	};
	state.footer = { ...state.footer, liveState: "Waiting approval", liveStateKind: "waiting_approval", turnRunning: true };
	state.settings = { reducedMotion: true };
	state.pendingInput = {
		pendingSteers: [], rejectedSteers: [],
		followUps: [{ queueId: "next", text: "Then summarize the results", hasImages: false }],
	};
	const responses: string[] = [];
	const runtime = new MycliShellRuntime({
		initialState: state, terminal,
		onApprovalRespond: (_decisionId, choice) => { responses.push(choice); },
	});
	context.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
	runtime.start();
	await flush(terminal);
	const initial = terminal.visibleLines().join("\n");
	assert.match(initial, /Permission required/);
	assert.match(initial, /1\. Allow once/);
	assert.match(initial, /esc reject/);
	assert.ok(runtime.ui.render(40).length <= 24, initial);
	terminal.sendInput("\x01");
	await flush(terminal);
	terminal.sendInput("\x1b[F");
	await flush(terminal);
	assert.match(terminal.visibleLines().join("\n"), /report-40\.txt/);
	terminal.sendInput("1");
	terminal.sendInput("\r");
	await flush(terminal);
	assert.deepEqual(responses, []);
	terminal.sendInput("\x1b");
	await flush(terminal);
	assert.match(terminal.visibleLines().join("\n"), /esc reject/);
	assert.deepEqual(responses, []);
	terminal.sendInput("2");
	await flush(terminal);
	assert.deepEqual(responses, ["reject"]);
});

test("runtime permission persistence stays pending until the callback settles and errors redraw in place", async (context) => {
	const terminal = new HeadlessTerminal({ columns: 80, rows: 24, nativeScrollback: true });
	let rejectSave: (error: Error) => void = () => assert.fail("save has not started");
	const save = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
	let saves = 0;
	const runtime = new MycliShellRuntime({
		initialState: initialState(), terminal,
		onPermissionSelect: () => { saves += 1; return save; },
	});
	context.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
	runtime.start();
	runtime.showPermissionSelector();
	terminal.sendInput("2");
	await flush(terminal);
	assert.match(terminal.visibleLines().join("\n"), /Confirm Full Access/);
	assert.equal(saves, 0);
	terminal.sendInput("\r");
	terminal.sendInput("\r");
	await flush(terminal);
	assert.equal(saves, 1);
	assert.match(terminal.visibleLines().join("\n"), /Saving permissions/);
	assert.equal(runtime.getState().permissions?.active, "workspace");
	rejectSave(new Error("Permission update unavailable"));
	await flush(terminal);
	assert.match(terminal.visibleLines().join("\n"), /Permission update unavailable/);
	assert.doesNotMatch(terminal.visibleLines().join("\n"), /Saving permissions/);
	assert.equal(runtime.getState().permissions?.active, "workspace");
	assert.doesNotMatch(stripAnsi(runtime.chatContainer.render(80).join("\n")), /Permissions updated/);
});

test("shell commands remain visible with queued input when approval panels resize", async (context) => {
	for (const nativeScrollback of [false, true]) {
		const terminal = new HeadlessTerminal({ columns: 80, rows: 24, nativeScrollback });
		const state = initialState();
		state.pendingApproval = {
			decisionId: "shell-command", toolName: "Shell", preview: "Shell npm requires approval",
			commandPreview: "npm run build --workspace app\n  npm test -- --runInBand",
			reason: "The command needs access outside the active sandbox. ".repeat(8),
			options: [
				{ choice: "approve_once", label: "Allow once" },
				{ choice: "reject", label: "Reject" },
				{ choice: "allow_session", label: "Allow for this session" },
			],
		};
		state.footer = { ...state.footer, liveState: "Waiting approval", liveStateKind: "waiting_approval", turnRunning: true };
		state.settings = { reducedMotion: true };
		state.pendingInput = {
			pendingSteers: [], rejectedSteers: [],
			followUps: [{ queueId: "next", text: "Then summarize the results", hasImages: false }],
		};
		const runtime = new MycliShellRuntime({ initialState: state, terminal });
		context.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
		runtime.start();
		for (const [width, height] of [[80, 24], [40, 24], [32, 12], [120, 24]] as const) {
			terminal.resize(width, height);
			await delay(120);
			await terminal.flush();
			const output = terminal.visibleLines().join("\n");
			assert.match(output, /\$ npm run build/u, `${width}x${height}: ${output}`);
			assert.match(output, /1\. Allow once/u);
			assert.ok(runtime.ui.render(width).length <= height, output);
		}
	}
});
