import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalToolCall } from "@mycli/core";
import * as tools from "../../src/index.ts";
import type {
	ExecutionPolicy,
	ToolExecutionResult,
} from "../../src/index.ts";

const WORKSPACE_EXECUTION_POLICY: ExecutionPolicy = Object.freeze({
	mode: "workspace-write",
	filesystem: "workspace_write",
	network: "disabled",
	writableRoots: Object.freeze(["/private/workspace"]),
});

test("default policy auto-allows valid workspace reads and mutations", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });

	assert.equal(policy.evaluate(toolCall("Read", { file_path: "notes.txt" })).kind, "allow");
	assert.equal(policy.evaluate(writeCall("notes.txt")).kind, "allow");
});

test("strict-medium requests one-time approval without allowing workspace escape", () => {
	const policy = approvalPolicy({ autoApproveMedium: false });

	const local = policy.evaluate(writeCall("notes.txt"));
	assert.equal(local.kind, "request");
	assert.deepEqual(local.options, ["approve_once", "reject"]);
	assert.equal(policy.evaluate(writeCall("../outside.txt")).kind, "deny");
	assert.equal(policy.evaluate(writeCall("/private/outside.txt")).kind, "deny");
});

test("file escalation is a one-time exact retry after workspace denial", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	policy.beginTurn("turn-1");
	const denied = writeCall("../outside.txt");
	assert.equal(policy.evaluate(denied, WORKSPACE_EXECUTION_POLICY, "turn-1").kind, "deny");

	const changedOperation = toolCall("Write", {
		file_path: "../outside.txt",
		content: "different",
		sandbox_permissions: "danger-full-access",
		justification: "The requested output must be written beside the workspace.",
	});
	assert.equal(
		policy.evaluate(changedOperation, WORKSPACE_EXECUTION_POLICY, "turn-1").kind,
		"deny",
	);

	const retry = toolCall("Write", {
		content: "hello",
		justification: "The requested output must be written beside the workspace.",
		sandbox_permissions: "danger-full-access",
		file_path: "../outside.txt",
	});
	const requested = policy.evaluate(retry, WORKSPACE_EXECUTION_POLICY, "turn-1");
	assert.equal(requested.kind, "request");
	assert.deepEqual(requested.options, ["approve_once", "reject"]);
	assert.equal(
		requested.reason,
		"The requested output must be written beside the workspace.",
	);
	assert.equal(requested.preview.includes("/private/workspace"), false);
	assert.equal(requested.preview.includes("justification"), false);

	assert.equal(policy.evaluate(retry, WORKSPACE_EXECUTION_POLICY, "turn-1").kind, "deny");
	policy.finishTurn("turn-1");
});

test("runtime workspace_escape results authorize a matching symlink retry", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	policy.beginTurn("turn-symlink");
	const original = writeCall("link/outside.txt");
	assert.equal(
		policy.evaluate(original, WORKSPACE_EXECUTION_POLICY, "turn-symlink").kind,
		"allow",
	);
	policy.recordResult(original, {
		callId: original.callId,
		toolName: original.name,
		success: false,
		modelOutput: "Write failed",
		summary: "Write failed",
		errorKind: "workspace_escape",
		metadata: {},
	}, WORKSPACE_EXECUTION_POLICY, "turn-symlink");

	const retry = toolCall("Write", {
		file_path: "link/outside.txt",
		content: "hello",
		sandbox_permissions: "danger-full-access",
		justification: "The workspace link intentionally targets the requested file.",
	});
	assert.equal(
		policy.evaluate(retry, WORKSPACE_EXECUTION_POLICY, "turn-symlink").kind,
		"request",
	);
});

test("file escalation validates permissions and justification before approval", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	policy.beginTurn("turn-invalid");
	policy.evaluate(writeCall("../outside.txt"), WORKSPACE_EXECUTION_POLICY, "turn-invalid");

	const missingJustification = policy.evaluate(toolCall("Write", {
		file_path: "../outside.txt",
		content: "hello",
		sandbox_permissions: "danger-full-access",
	}), WORKSPACE_EXECUTION_POLICY, "turn-invalid");
	assert.equal(missingJustification.kind, "deny");
	assert.equal(missingJustification.errorKind, "invalid_justification");

	const invalidPermission = policy.evaluate(toolCall("Write", {
		file_path: "../outside.txt",
		content: "hello",
		sandbox_permissions: "host",
		justification: "Use host access.",
	}), WORKSPACE_EXECUTION_POLICY, "turn-invalid");
	assert.equal(invalidPermission.kind, "deny");
	assert.equal(invalidPermission.errorKind, "invalid_sandbox_permissions");

	assert.equal(policy.evaluate(toolCall("Write", {
		file_path: "notes.txt",
		content: "hello",
		justification: "No escalation was requested.",
	}), WORKSPACE_EXECUTION_POLICY, "turn-invalid").kind, "allow");
});

test("approval previews are bounded and exclude content hashes and real workspace paths", () => {
	const secretBody = "token=private-value-that-must-not-appear";
	const hash = "a".repeat(64);
	const policy = approvalPolicy({ autoApproveMedium: false });

	const decision = policy.evaluate(toolCall("Write", {
		file_path: "nested/" + "long-name-".repeat(100) + ".txt",
		content: secretBody,
		expected_sha256: hash,
	}));

	assert.equal(decision.kind, "request");
	assert.ok(decision.preview.length <= 512);
	assert.equal(decision.preview.includes(secretBody), false);
	assert.equal(decision.preview.includes(hash), false);
	assert.equal(decision.preview.includes("/private/workspace"), false);
});

test("file mutation approval previews expose bounded Write content", () => {
	const content = "first\r\nsecond\n\n";
	const preview = tools.fileMutationApprovalPreview(toolCall("Write", {
		file_path: "notes.txt",
		content,
	}));

	assert.deepEqual(preview, {
		contentPreview: content,
		contentLineCount: 3,
		contentChars: content.length,
		contentTruncated: false,
	});

	const largeContent = `${"x".repeat(12_000)}tail`;
	const bounded = tools.fileMutationApprovalPreview(toolCall("write_file", {
		file_path: "large.txt",
		content: largeContent,
	}));
	assert.equal(bounded.contentPreview?.length, 12_000);
	assert.equal(bounded.contentChars, largeContent.length);
	assert.equal(bounded.contentTruncated, true);
});

test("file mutation approval previews preserve both sides of bounded Edit and Patch diffs", () => {
	const edit = tools.fileMutationApprovalPreview(toolCall("Edit", {
		file_path: "notes.txt",
		old_string: "before\nold tail",
		new_string: "after\nnew tail",
	}));
	assert.deepEqual(edit, {
		diff: "-before\n-old tail\n+after\n+new tail",
		diffChars: 34,
		diffTruncated: false,
	});

	const patch = tools.fileMutationApprovalPreview(toolCall("Patch", {
		file_path: "notes.txt",
		old_string: Array.from({ length: 20 }, (_, index) => `old ${index}`).join("\n"),
		new_string: Array.from({ length: 20 }, (_, index) => `new ${index}`).join("\n"),
	}));
	assert.match(patch.diff ?? "", /^-old 0/mu);
	assert.match(patch.diff ?? "", /^\+new 0/mu);
	assert.match(patch.diff ?? "", /removed lines omitted/u);
	assert.match(patch.diff ?? "", /added lines omitted/u);
	assert.equal(patch.diffTruncated, true);
	assert.ok((patch.diffChars ?? 0) > (patch.diff?.length ?? 0));
});

test("malformed and unsupported tool calls fail closed", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });

	assert.equal(policy.evaluate({
		callId: "call-invalid",
		name: "Write",
		argumentsJson: "not-json",
	}).kind, "deny");
	assert.equal(policy.evaluate(toolCall("Unknown", {})).kind, "deny");
});

test("extension approval metadata allows local controls and gates external tools", () => {
	const policy = approvalPolicy({
		autoApproveMedium: true,
		extensionTools: [
			{ name: "spawn_agent", approvalPolicy: "auto_allow" },
			{ name: "McpSearch", approvalPolicy: "request" },
		],
	});

	assert.equal(policy.evaluate(toolCall("spawn_agent", {
		task_name: "inspect",
		message: "Inspect.",
	})).kind, "allow");
	const external = policy.evaluate(toolCall("McpSearch", { query: "docs" }));
	assert.equal(external.kind, "request");
	assert.deepEqual(external.options, ["approve_once", "reject"]);
	assert.equal(policy.evaluate(toolCall("UnknownExtension", {})).kind, "deny");
});

test("full access skips routine approval for valid tools", () => {
	const policy = approvalPolicy({
		autoApproveMedium: false,
		extensionTools: [{ name: "McpSearch", approvalPolicy: "request" }],
	});
	const shell = toolCall("Shell", { command: "python deploy.py" });
	assert.equal(policy.evaluate(shell).kind, "allow");

	policy.configurePermissionProfile("full-access");

	assert.equal(policy.evaluate(shell).kind, "allow");
	assert.equal(policy.evaluate(writeCall("notes.txt")).kind, "allow");
	assert.equal(policy.evaluate(writeCall("../outside.txt")).kind, "allow");
	assert.equal(policy.evaluate(writeCall("/private/outside.txt")).kind, "allow");
	assert.equal(policy.evaluate(toolCall("Write", {
		file_path: "notes.txt",
		content: "hello",
		sandbox_permissions: "workspace-write",
		justification: "Redundant non-escalation reason.",
	})).kind, "allow");
	assert.equal(policy.evaluate(toolCall("McpSearch", { query: "docs" })).kind, "allow");
	assert.equal(policy.evaluate(shell, WORKSPACE_EXECUTION_POLICY).kind, "allow");
});

test("full access keeps explicit rules and invalid calls fail closed", () => {
	const ask = approvalPolicy({
		autoApproveMedium: true,
		execPolicyRules: [{
			source: "project",
			index: 0,
			pattern: ["python", "review.py"],
			decision: "ask",
		}],
	});
	ask.configurePermissionProfile("full-access");
	assert.equal(ask.evaluate(toolCall("Shell", { command: "python review.py" })).kind, "deny");

	const deny = approvalPolicy({
		autoApproveMedium: true,
		execPolicyRules: [{
			source: "project",
			index: 0,
			pattern: ["python", "deploy.py"],
			decision: "deny",
		}],
	});
	deny.configurePermissionProfile("full-access");
	assert.equal(deny.evaluate(toolCall("Shell", { command: "python deploy.py" })).kind, "deny");
	assert.equal(deny.evaluate({
		callId: "call-invalid",
		name: "Shell",
		argumentsJson: "not-json",
	}).kind, "deny");
	assert.equal(deny.evaluate(toolCall("Shell", {
		command: "pwd",
		sandbox_permissions: "invalid",
	})).kind, "deny");
	assert.equal(deny.evaluate(toolCall("Unknown", {})).kind, "deny");
});

test("full access never prompts for complex or malformed shell commands", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	policy.configurePermissionProfile("full-access");

	assert.equal(policy.evaluate(toolCall("Shell", { command: "echo ready > output.txt" })).kind, "allow");
	assert.equal(policy.evaluate(toolCall("Shell", { command: "echo 'unterminated" })).kind, "deny");

	const restricted = approvalPolicy({
		autoApproveMedium: true,
		execPolicyRules: [{
			source: "project",
			index: 0,
			pattern: ["rm"],
			decision: "deny",
		}],
	});
	restricted.configurePermissionProfile("full-access");
	assert.equal(restricted.evaluate(toolCall("Shell", { command: "echo ready > output.txt" })).kind, "deny");
});

test("shell policy runs safe and unknown commands in the active sandbox", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });

	assert.equal(policy.evaluate(toolCall("Shell", { command: "pwd" })).kind, "allow");
	assert.equal(policy.evaluate(toolCall("Shell", { command: "python script.py" })).kind, "allow");
	assert.equal(policy.evaluate(toolCall("Bash", { command: "python script.py" })).kind, "request");
	assert.equal(policy.evaluate(toolCall("Shell", { command: "rm -rf build", justification: "Remove generated build files." })).kind, "request");
	assert.equal(policy.evaluate(toolCall("Shell", { command: "echo ready > output.txt", justification: "Write the readiness marker." })).kind, "request");
});

test("restricted Shell escalation requests approval and validates the enum", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	const withoutProposal = policy.evaluate(toolCall("Shell", {
		command: "python script.py",
		sandbox_permissions: "require_escalated",
		justification: "Run the requested script with the required access.",
	}));
	assert.equal(withoutProposal.kind, "request");
	assert.deepEqual(withoutProposal.options, ["approve_once", "reject", "allow_session"]);

	const persistent = policy.evaluate(toolCall("Shell", {
		command: "python -m pytest -q",
		prefix_rule: ["python", "-m", "pytest"],
		sandbox_permissions: "require_escalated",
		justification: "Run tests that require access to the shared fixture directory.",
	}));
	assert.equal(persistent.kind, "request");
	assert.deepEqual(persistent.options, [
		"approve_once",
		"reject",
		"allow_session",
		"always_allow",
	]);
	assert.deepEqual(persistent.proposedExecPolicyPattern, ["python", "-m", "pytest"]);
	assert.deepEqual(persistent.commandPattern, ["python", "-m", "pytest"]);
	assert.equal(policy.evaluate(toolCall("Shell", {
		command: "pwd",
		sandbox_permissions: "invalid",
	})).kind, "deny");
});

test("invalid model approval reasons fail before an approval is requested", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	for (const justification of [null, 1, "", "  ", "x".repeat(513)]) {
		const decision = policy.evaluate(toolCall("Shell", {
			command: "pwd", sandbox_permissions: "require_escalated", justification,
		}));
		assert.equal(decision.kind, "deny");
		assert.equal(decision.errorKind, "invalid_arguments");
	}
});

test("missing model reasons preserve Shell approvals for escalation, risky syntax, and explicit rules", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	for (const args of [
		{ command: "git status --short --branch", sandbox_permissions: "require_escalated", description: "Inspect Git state." },
		{ command: "rm -rf build" },
		{ command: "echo ready > output.txt" },
	]) {
		const missing = policy.evaluate(toolCall("Shell", args));
		assert.equal(missing.kind, "request");
		assert.deepEqual(policy.evaluate(toolCall("Shell", { ...args, justification: "Perform the requested operation." })), missing);
	}
	const ask = approvalPolicy({ autoApproveMedium: true, execPolicyRules: [{
		source: "project", index: 0, pattern: ["git", "status"], decision: "ask",
	}] });
	assert.equal(ask.evaluate(toolCall("Shell", { command: "git status" })).kind, "request");
	assert.equal(policy.evaluate(toolCall("Shell", { command: "git status" })).kind, "allow");
	policy.allowSession?.(["git", "status"]);
	assert.equal(policy.evaluate(toolCall("Shell", { command: "git status", sandbox_permissions: "require_escalated" })).kind, "allow");
	policy.configurePermissionProfile("full-access");
	assert.equal(policy.evaluate(toolCall("Shell", { command: "rm -rf build" })).kind, "allow");
});

test("explicit project policy has precedence and persistent options cannot override ask or deny", () => {
	const deny = approvalPolicy({
		autoApproveMedium: true,
		execPolicyRules: [{
			source: "project",
			index: 0,
			pattern: ["python", "-m", "pytest"],
			decision: "deny",
		}],
	});
	assert.equal(deny.evaluate(toolCall("Shell", {
		command: "python -m pytest -q",
		prefix_rule: ["python", "-m", "pytest"],
	})).kind, "deny");

	const ask = approvalPolicy({
		autoApproveMedium: true,
		execPolicyRules: [{
			source: "project",
			index: 0,
			pattern: ["python", "-m", "pytest"],
			decision: "ask",
		}],
	}).evaluate(toolCall("Shell", {
		command: "python -m pytest -q",
		prefix_rule: ["python", "-m", "pytest"],
		justification: "Run the requested test suite.",
	}));
	assert.equal(ask.kind, "request");
	assert.equal(ask.options?.includes("always_allow"), false);
});

test("explicit rules remain authoritative for restricted Shell escalation", () => {
	const call = toolCall("Shell", {
		command: "python -m pytest -q",
		sandbox_permissions: "require_escalated",
		justification: "Run tests that require access to the shared fixture directory.",
	});
	const rule = (decision: "allow" | "ask" | "deny") => approvalPolicy({
		autoApproveMedium: true,
		execPolicyRules: [{
			source: "project",
			index: 0,
			pattern: ["python", "-m", "pytest"],
			decision,
		}],
	});

	const allowed = rule("allow").evaluate(call);
	assert.equal(allowed.kind, "allow");
	assert.equal(allowed.sandboxOverrideApproved, true);
	assert.equal(rule("ask").evaluate(call).kind, "request");
	assert.equal(rule("deny").evaluate(call).kind, "deny");
});

test("session allowances immediately authorize the exact command prefix", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	const call = toolCall("Shell", {
		command: "python -m pytest -q",
		sandbox_permissions: "require_escalated",
		justification: "Run tests that require access to the shared fixture directory.",
	});
	const requested = policy.evaluate(call);
	assert.equal(requested.kind, "request");
	assert.ok(requested.commandPattern);

	policy.allowSession?.(requested.commandPattern ?? []);

	const allowed = policy.evaluate(call);
	assert.equal(allowed.kind, "allow");
	assert.equal(allowed.sandboxOverrideApproved, true);
});

test("session allowances can be listed, revoked, and cleared without changing persistent rules", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	policy.allowSession?.(["git", "status"]);
	policy.allowSession?.(["npm", "test"]);

	assert.deepEqual(policy.listSessionAllowances?.(), [["git", "status"], ["npm", "test"]]);
	assert.equal(policy.removeSessionAllowance?.(["git", "status"]), true);
	assert.deepEqual(policy.listSessionAllowances?.(), [["npm", "test"]]);
	assert.equal(policy.clearSessionAllowances?.(), 1);
	assert.deepEqual(policy.listSessionAllowances?.(), []);
});

function approvalPolicy(options: {
	readonly autoApproveMedium: boolean;
	readonly execPolicyRules?: readonly {
		readonly source: "user" | "project" | "session";
		readonly index: number;
		readonly pattern: readonly string[];
		readonly decision: "allow" | "ask" | "deny";
	}[];
	readonly extensionTools?: readonly {
		readonly name: string;
		readonly approvalPolicy: "auto_allow" | "request";
	}[];
}): {
	configurePermissionProfile(profile: "read-only" | "workspace" | "full-access"): void;
	beginTurn(turnId: string): void;
	finishTurn(turnId: string): void;
	evaluate(call: CanonicalToolCall, executionPolicy?: ExecutionPolicy, turnId?: string): {
		readonly kind: string;
		readonly preview: string;
		readonly reason: string;
		readonly options?: readonly string[];
		readonly commandPattern?: readonly string[];
		readonly proposedExecPolicyPattern?: readonly string[];
		readonly sandboxOverrideApproved?: boolean;
		readonly errorKind?: string;
	};
	recordResult(
		call: CanonicalToolCall,
		result: ToolExecutionResult,
		executionPolicy?: ExecutionPolicy,
		turnId?: string,
	): void;
	allowSession?(pattern: readonly string[]): void;
	listSessionAllowances?(): readonly (readonly string[])[];
	removeSessionAllowance?(pattern: readonly string[]): boolean;
	clearSessionAllowances?(): number;
} {
	const Constructor = Reflect.get(tools, "ApprovalPolicy");
	assert.equal(typeof Constructor, "function", "ApprovalPolicy must be exported");
	return new (Constructor as new (input: {
			readonly workspaceRoot: string;
			readonly autoApproveMedium: boolean;
			readonly shellKind?: "posix";
			readonly execPolicyRules?: readonly Readonly<Record<string, unknown>>[];
			readonly extensionTools?: readonly Readonly<Record<string, unknown>>[];
		}) => {
			configurePermissionProfile(profile: "read-only" | "workspace" | "full-access"): void;
			beginTurn(turnId: string): void;
			finishTurn(turnId: string): void;
			evaluate(call: CanonicalToolCall, executionPolicy?: ExecutionPolicy, turnId?: string): {
				readonly kind: string;
				readonly preview: string;
				readonly reason: string;
				readonly options?: readonly string[];
				readonly commandPattern?: readonly string[];
				readonly proposedExecPolicyPattern?: readonly string[];
				readonly sandboxOverrideApproved?: boolean;
				readonly errorKind?: string;
			};
			recordResult(
				call: CanonicalToolCall,
				result: ToolExecutionResult,
				executionPolicy?: ExecutionPolicy,
				turnId?: string,
			): void;
			allowSession?(pattern: readonly string[]): void;
			listSessionAllowances?(): readonly (readonly string[])[];
			removeSessionAllowance?(pattern: readonly string[]): boolean;
			clearSessionAllowances?(): number;
		})({
		workspaceRoot: "/private/workspace",
		autoApproveMedium: options.autoApproveMedium,
		shellKind: "posix",
		...(options.execPolicyRules ? { execPolicyRules: options.execPolicyRules } : {}),
		...(options.extensionTools ? { extensionTools: options.extensionTools } : {}),
	});
}

function writeCall(path: string): CanonicalToolCall {
	return toolCall("Write", { file_path: path, content: "hello" });
}

function toolCall(name: string, argumentsValue: Readonly<Record<string, unknown>>): CanonicalToolCall {
	return {
		callId: `call-${name.toLowerCase()}`,
		name,
		argumentsJson: JSON.stringify(argumentsValue),
	};
}
