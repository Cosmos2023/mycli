import assert from "node:assert/strict";
import test from "node:test";
import {
	AgentPathError,
	AgentAuthorityError,
	AgentTransitionError,
	agentMailboxDedupeKey,
	agentMailboxMessageId,
	agentMailboxMessageIdFor,
	agentPathDepth,
	agentThreadId,
	assertAgentStatusTransition,
	canTransitionAgentStatus,
	childAgentPath,
	isAgentPathWithin,
	isSameAgentTree,
	narrowAgentExecutionPolicy,
	parseAgentForkTurns,
	parseAgentPath,
	rootAgentPath,
	selectAgentForkConversation,
} from "../../src/index.ts";

test("builds deterministic mailbox dedupe and message identities", () => {
	const input = {
		namespace: "coordination_call",
		rootThreadId: agentThreadId("root-thread"),
		senderThreadId: agentThreadId("sender-thread"),
		receiverThreadId: agentThreadId("receiver-thread"),
		logicalId: "call-1",
	};
	const first = agentMailboxDedupeKey(input);
	const second = agentMailboxDedupeKey({ ...input });
	assert.equal(first, second);
	assert.match(first, /^sha256:[a-f0-9]{64}$/u);
	const messageId = agentMailboxMessageIdFor(input.receiverThreadId, first);
	assert.match(messageId, /^mailbox-[a-f0-9]{64}$/u);
	assert.equal(agentMailboxMessageId(messageId), messageId);
	assert.notEqual(
		agentMailboxMessageIdFor(agentThreadId("other-receiver"), first),
		messageId,
	);
	assert.throws(() => agentMailboxMessageId("mailbox-invalid"), AgentPathError);
});

test("constructs and validates canonical agent paths", () => {
	const root = rootAgentPath();
	const child = childAgentPath(root, "test-writer");
	const grandchild = childAgentPath(child, "review_2");

	assert.equal(child, "/root/test-writer");
	assert.equal(grandchild, "/root/test-writer/review_2");
	assert.equal(agentPathDepth(root), 0);
	assert.equal(agentPathDepth(grandchild), 2);
	assert.equal(isAgentPathWithin(grandchild, child), true);
	assert.equal(isAgentPathWithin(child, grandchild), false);
});

test("parses explicit fork modes and defaults to no copied history", () => {
	assert.equal(parseAgentForkTurns(undefined), "none");
	assert.equal(parseAgentForkTurns("all"), "all");
	assert.deepEqual(parseAgentForkTurns("3"), { kind: "last_n", turns: 3 });
	for (const value of ["0", "-1", "1.5", "recent", "9007199254740992"] as const) {
		assert.throws(() => parseAgentForkTurns(value), TypeError);
	}
});

test("selects whole recent turns and strips provider continuation state", () => {
	const items = [
		{ type: "user", text: "first" },
		{ type: "assistant", text: "one", providerState: { provider: "openai", value: { id: 1 } } },
		{ type: "user", text: "second" },
		{
			type: "assistant_tool_calls",
			text: "checking",
			calls: [
				{ callId: "kept", name: "Read", argumentsJson: "{}" },
				{ callId: "orphan", name: "Read", argumentsJson: "{}" },
			],
			responseId: "response-private",
			providerState: { provider: "openai", value: { signature: "private" } },
		},
		{ type: "tool_result", callId: "kept", toolName: "Read", output: "ok", success: true },
	] as const;
	assert.deepEqual(selectAgentForkConversation(items, { kind: "last_n", turns: 1 }), [
		{ type: "user", text: "second" },
		{
			type: "assistant_tool_calls",
			text: "checking",
			calls: [{ callId: "kept", name: "Read", argumentsJson: "{}" }],
		},
		{ type: "tool_result", callId: "kept", toolName: "Read", output: "ok", success: true },
	]);
	assert.deepEqual(selectAgentForkConversation(items, "none"), []);
});

test("inherits full access exactly and rejects broader child authority", () => {
	const full = {
		trusted: true,
		permission: "full-access",
		sandboxMode: "danger-full-access",
		filesystem: "unrestricted",
		network: "enabled",
		writableRoots: ["/workspace"],
	} as const;
	assert.deepEqual(narrowAgentExecutionPolicy(full), full);
	assert.deepEqual(narrowAgentExecutionPolicy(full, {
		trusted: true,
		permission: "read-only",
		sandboxMode: "read-only",
		filesystem: "read_only",
		network: "disabled",
		writableRoots: [],
	}), {
		trusted: true,
		permission: "read-only",
		sandboxMode: "read-only",
		filesystem: "read_only",
		network: "disabled",
		writableRoots: [],
	});
	assert.throws(() => narrowAgentExecutionPolicy({
		trusted: true,
		permission: "workspace",
		sandboxMode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		writableRoots: ["/workspace"],
	}, full), AgentAuthorityError);
});

test("preserves approval-required authority and allows explicit narrowing", () => {
	const approvalRequired = {
		trusted: true,
		permission: "workspace",
		sandboxMode: "workspace-write",
		filesystem: "workspace_write",
		network: "enabled",
		writableRoots: ["/workspace"],
	} as const;
	assert.deepEqual(narrowAgentExecutionPolicy(approvalRequired), approvalRequired);
	assert.deepEqual(narrowAgentExecutionPolicy(approvalRequired, {
		trusted: true,
		permission: "read-only",
		sandboxMode: "read-only",
		filesystem: "read_only",
		network: "disabled",
		writableRoots: [],
	}), {
		trusted: true,
		permission: "read-only",
		sandboxMode: "read-only",
		filesystem: "read_only",
		network: "disabled",
		writableRoots: [],
	});
	assert.throws(() => narrowAgentExecutionPolicy({
		...approvalRequired,
		trusted: false,
	}, approvalRequired), AgentAuthorityError);
});

test("subagents inherit network domain constraints without widening them", () => {
	const constrained = {
		trusted: true,
		permission: "full-access",
		sandboxMode: "danger-full-access",
		filesystem: "unrestricted",
		network: "enabled",
		networkDomains: ["api.example.com", "*.assets.example.com"],
		writableRoots: ["/workspace"],
	} as const;

	assert.deepEqual(narrowAgentExecutionPolicy(constrained), constrained);
	assert.throws(() => narrowAgentExecutionPolicy(constrained, {
		...constrained,
		networkDomains: undefined,
	}), AgentAuthorityError);
	assert.deepEqual(narrowAgentExecutionPolicy(constrained, {
		...constrained,
		networkDomains: ["api.example.com"],
	}), {
		...constrained,
		networkDomains: ["api.example.com"],
	});
});

test("rejects ambiguous or non-canonical paths and task names", () => {
	for (const value of ["root/a", "/other/a", "/root/../a", "/root/A", "/root/a/", " /root/a"] as const) {
		assert.throws(() => parseAgentPath(value), AgentPathError);
	}
	for (const name of ["", "A", "-a", "a-", "a/b", ".", ".."] as const) {
		assert.throws(() => childAgentPath(rootAgentPath(), name), AgentPathError);
	}
});

test("uses root thread identity rather than display path for tree authorization", () => {
	const first = agentThreadId("root-thread-1");
	const second = agentThreadId("root-thread-2");
	assert.equal(isSameAgentTree(first, first), true);
	assert.equal(isSameAgentTree(first, second), false);
});

test("accepts declared lifecycle transitions and rejects terminal restart", () => {
	assert.equal(canTransitionAgentStatus("queued", "running"), true);
	assert.equal(canTransitionAgentStatus("running", "waiting"), true);
	assert.equal(canTransitionAgentStatus("waiting", "running"), true);
	assert.equal(canTransitionAgentStatus("idle", "unloaded"), true);
	assert.equal(canTransitionAgentStatus("unloaded", "running"), true);
	assert.equal(canTransitionAgentStatus("completed", "running"), false);
	assert.doesNotThrow(() => assertAgentStatusTransition("running", "completed"));
	assert.throws(
		() => assertAgentStatusTransition("interrupted", "running"),
		AgentTransitionError,
	);
});

test("child authority cannot drop inherited read-deny roots or globs", () => {
	const parent = { trusted: true, permission: "workspace", sandboxMode: "workspace-write", filesystem: "workspace_write", network: "enabled",
		writableRoots: ["/workspace"], deniedReadRoots: ["/workspace/secret"], deniedReadGlobs: ["**/.env"] } as const;
	assert.throws(() => narrowAgentExecutionPolicy(parent, { ...parent, deniedReadRoots: [] }), AgentAuthorityError);
	assert.throws(() => narrowAgentExecutionPolicy(parent, { ...parent, deniedReadGlobs: [] }), AgentAuthorityError);
	const child = narrowAgentExecutionPolicy(parent);
	assert.deepEqual(child.deniedReadRoots, parent.deniedReadRoots);
	assert.equal(Object.isFrozen(child.deniedReadGlobs), true);
});
