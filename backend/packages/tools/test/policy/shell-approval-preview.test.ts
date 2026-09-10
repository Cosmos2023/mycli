import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalToolCall } from "@mycli/core";
import { ApprovalPolicy, shellApprovalPreview } from "../../src/index.ts";

function call(command: string, name = "Shell", justification?: string): CanonicalToolCall {
	return { callId: "shell-approval", name, argumentsJson: JSON.stringify({
		command, sandbox_permissions: "require_escalated",
		description: "A friendly summary",
		...(justification ? { justification } : {}),
	}) };
}

test("shell approval details preserve the canonical command independently of the policy summary", () => {
	const commands = [
		"rm -rf -- 'build output'",
		"npm run build --workspace app && npm test",
		"node <<'SCRIPT'\n  console.log('first  second');\n\tconsole.log('\u4e2d\u6587');\r\nSCRIPT",
	];
	for (const name of ["Shell", "Bash"]) {
		for (const command of commands) {
			const justification = name === "Shell" ? "Review the requested command." : undefined;
			const tool = call(command, name, justification);
			const policy = new ApprovalPolicy({ workspaceRoot: "/workspace", shellKind: "posix" });
			const decision = policy.evaluate(tool);
			assert.equal(decision.kind, "request");
			assert.deepEqual(shellApprovalPreview(tool), {
				commandPreview: command, commandTruncated: false, ...(justification ? { justification } : {}),
			});
			assert.doesNotMatch(decision.preview, /first {2}second|A friendly summary/u);
		}
	}
});

test("shell approvals expose the model reason separately without changing policy decisions", () => {
	const tool = call("npm install");
	const justification = "Download the dependencies needed to run the project tests.";
	const withReason = { ...tool, argumentsJson: JSON.stringify({
		...JSON.parse(tool.argumentsJson), justification: `  ${justification}  `,
	}) };
	const policy = new ApprovalPolicy({ workspaceRoot: "/workspace", shellKind: "posix" });
	assert.deepEqual(policy.evaluate(tool), policy.evaluate(withReason));
	assert.deepEqual(policy.evaluate(withReason), policy.evaluate(call("npm install", "Shell", "Another user-facing reason.")));
	assert.equal(policy.evaluate(withReason).kind, "request");
	assert.deepEqual(shellApprovalPreview(withReason), {
		commandPreview: "npm install", commandTruncated: false, justification,
	});
	assert.equal(shellApprovalPreview(tool).justification, undefined);
	assert.equal(shellApprovalPreview({ ...withReason, name: "Bash" }).justification, undefined);
});

test("model approval reasons are redacted, escaped, and bounded independently of the command", () => {
	const tool = (justification: unknown): CanonicalToolCall => ({
		callId: "reason", name: "Shell", argumentsJson: JSON.stringify({ command: "npm install", justification }),
	});
	const preview = shellApprovalPreview(tool("Download dependencies using API_KEY=private-value.\x1b[2J\u202e"));
	assert.doesNotMatch(preview.justification ?? "", /private-value/u);
	assert.equal(preview.justification?.includes("\x1b"), false);
	assert.equal(preview.justification?.includes("\u202e"), false);
	assert.match(preview.justification ?? "", /\[REDACTED\]/u);
	assert.equal(preview.commandPreview, "npm install");
	assert.match(shellApprovalPreview(tool("Review command\x1b[2J\u202e")).justification ?? "", /\\u001b\[2J\\u202e/u);
	const expanded = shellApprovalPreview(tool("\u202e".repeat(512))).justification!;
	assert.equal(Array.from(expanded).length, 512);
	assert.ok(expanded.endsWith("..."));
	for (const invalid of [null, 1, "", "  ", "x".repeat(513)]) {
		assert.equal(shellApprovalPreview(tool(invalid)).justification, undefined);
	}
});

test("shell approval previews redact credential values without hiding the command and other arguments", () => {
	const command = [
		'API_KEY="private env value" curl --password "private option value"',
		"  -H 'Authorization: Bearer private-bearer-value'",
		"  -H 'Cookie: session=private-cookie-value; other=private-cookie-tail'",
		"  --data '{\"api_key\":\"private-json-value\"}'",
		"  'https://example.test/api?key=private-query-value&format=json'",
		"  'https://user:private-url-value@example.test/api'",
		"  --output 'result file.json'",
	].join(" \\\n");
	const tool = call(command);
	const preview = shellApprovalPreview(tool).commandPreview!;
	assert.doesNotMatch(preview, /private-/u);
	assert.doesNotMatch(preview, /private env value|private option value/u);
	assert.match(preview, /API_KEY=\[REDACTED\] curl --password \[REDACTED\]/u);
	assert.match(preview, /format=json/u);
	assert.match(preview, /--output 'result file\.json'/u);
	assert.equal(JSON.parse(tool.argumentsJson).command, command);
});

test("shell previews escape terminal controls and redact before truncating", () => {
	assert.equal(shellApprovalPreview(call("echo '\x1b[2J\x07\u202eend'\n\tprintf done")).commandPreview,
		"echo '\\u001b[2J\\u0007\\u202eend'\n\tprintf done");
	const prefix = "echo " + "x".repeat(12_010);
	const preview = shellApprovalPreview(call(`${prefix}; echo tail`));
	assert.equal(preview.commandPreview?.length, 12_000);
	assert.equal(preview.commandTruncated, true);
	const redacted = shellApprovalPreview(call(`API_KEY='${"s".repeat(13_000)}' npm test`));
	assert.deepEqual(redacted, { commandPreview: "API_KEY=[REDACTED] npm test", commandTruncated: false });
});

test("unsupported or invalid calls cannot supply a shell approval preview", () => {
	assert.deepEqual(shellApprovalPreview(call("rm -rf build", "Write")), {});
	for (const argumentsJson of ["not-json", "null", "[]", "{}", '{"command":1}', '{"command":" "}']) {
		assert.deepEqual(shellApprovalPreview({ callId: "invalid", name: "Shell", argumentsJson }), {});
	}
});
