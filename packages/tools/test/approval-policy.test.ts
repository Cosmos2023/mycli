import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalToolCall } from "@mycli/core";
import * as tools from "../src/index.ts";

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

test("malformed and unsupported tool calls fail closed", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });

	assert.equal(policy.evaluate({
		callId: "call-invalid",
		name: "Write",
		argumentsJson: "not-json",
	}).kind, "deny");
	assert.equal(policy.evaluate(toolCall("Unknown", {})).kind, "deny");
});

test("shell policy allows known-safe commands and requests narrow approval options", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });

	assert.equal(policy.evaluate(toolCall("Shell", { command: "pwd" })).kind, "allow");
	const withoutProposal = policy.evaluate(toolCall("Shell", { command: "python script.py" }));
	assert.equal(withoutProposal.kind, "request");
	assert.deepEqual(withoutProposal.options, ["approve_once", "reject", "allow_session"]);

	const persistent = policy.evaluate(toolCall("Shell", {
		command: "python -m pytest -q",
		prefix_rule: ["python", "-m", "pytest"],
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
	}));
	assert.equal(ask.kind, "request");
	assert.equal(ask.options?.includes("always_allow"), false);
});

test("session allowances immediately authorize the exact command prefix", () => {
	const policy = approvalPolicy({ autoApproveMedium: true });
	const call = toolCall("Shell", { command: "python -m pytest -q" });
	const requested = policy.evaluate(call);
	assert.equal(requested.kind, "request");
	assert.ok(requested.commandPattern);

	policy.allowSession?.(requested.commandPattern ?? []);

	assert.equal(policy.evaluate(call).kind, "allow");
});

function approvalPolicy(options: {
	readonly autoApproveMedium: boolean;
	readonly execPolicyRules?: readonly {
		readonly source: "user" | "project" | "session";
		readonly index: number;
		readonly pattern: readonly string[];
		readonly decision: "allow" | "ask" | "deny";
	}[];
}): {
	evaluate(call: CanonicalToolCall): {
		readonly kind: string;
		readonly preview: string;
		readonly options?: readonly string[];
		readonly commandPattern?: readonly string[];
		readonly proposedExecPolicyPattern?: readonly string[];
	};
	allowSession?(pattern: readonly string[]): void;
} {
	const Constructor = Reflect.get(tools, "ApprovalPolicy");
	assert.equal(typeof Constructor, "function", "ApprovalPolicy must be exported");
	return new (Constructor as new (input: {
			readonly workspaceRoot: string;
			readonly autoApproveMedium: boolean;
			readonly shellKind?: "posix";
			readonly execPolicyRules?: readonly Readonly<Record<string, unknown>>[];
		}) => {
			evaluate(call: CanonicalToolCall): {
				readonly kind: string;
				readonly preview: string;
				readonly options?: readonly string[];
				readonly commandPattern?: readonly string[];
				readonly proposedExecPolicyPattern?: readonly string[];
			};
			allowSession?(pattern: readonly string[]): void;
		})({
		workspaceRoot: "/private/workspace",
		autoApproveMedium: options.autoApproveMedium,
		shellKind: "posix",
		...(options.execPolicyRules ? { execPolicyRules: options.execPolicyRules } : {}),
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
