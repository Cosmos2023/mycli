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
	assert.equal(policy.evaluate(toolCall("Shell", { command: "pwd" })).kind, "deny");
});

function approvalPolicy(options: { readonly autoApproveMedium: boolean }): {
	evaluate(call: CanonicalToolCall): {
		readonly kind: string;
		readonly preview: string;
		readonly options?: readonly string[];
	};
} {
	const Constructor = Reflect.get(tools, "ApprovalPolicy");
	assert.equal(typeof Constructor, "function", "ApprovalPolicy must be exported");
	return new (Constructor as new (input: {
		readonly workspaceRoot: string;
		readonly autoApproveMedium: boolean;
	}) => {
		evaluate(call: CanonicalToolCall): {
			readonly kind: string;
			readonly preview: string;
			readonly options?: readonly string[];
		};
	})({
		workspaceRoot: "/private/workspace",
		autoApproveMedium: options.autoApproveMedium,
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
