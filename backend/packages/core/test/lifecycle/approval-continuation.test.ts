import assert from "node:assert/strict";
import test from "node:test";
import {
	ApprovalConflictError,
	createWaitingApproval,
	transitionApproval,
} from "../../src/lifecycle/approval-continuation.ts";

test("moves an approved effect through claim and durable completion", () => {
	const waiting = createWaitingApproval("decision-1");
	const approved = transitionApproval(waiting, { type: "approve_once" });
	const executing = transitionApproval(approved, {
		type: "claim_effect",
		fingerprint: "sha256:a",
	});
	const completed = transitionApproval(executing, {
		type: "complete_effect",
		resultCallId: "call-result-1",
	});

	assert.equal(approved.status, "approved");
	assert.deepEqual(executing, {
		status: "executing",
		decisionId: "decision-1",
		fingerprint: "sha256:a",
	});
	assert.deepEqual(completed, {
		status: "completed",
		decisionId: "decision-1",
		fingerprint: "sha256:a",
		resultCallId: "call-result-1",
	});
	assert.ok(Object.isFrozen(completed));
});

test("effect claims cannot return to approved", () => {
	const approved = transitionApproval(createWaitingApproval("decision-1"), {
		type: "approve_once",
	});
	const executing = transitionApproval(approved, {
		type: "claim_effect",
		fingerprint: "sha256:a",
	});
	assert.throws(
		() => transitionApproval(executing, { type: "approve_once" }),
		ApprovalConflictError,
	);
});

test("repeated identical resolutions are idempotent and conflicts fail", () => {
	const waiting = createWaitingApproval("decision-1");
	const approved = transitionApproval(waiting, { type: "approve_once" });
	assert.equal(transitionApproval(approved, { type: "approve_once" }), approved);
	assert.throws(
		() => transitionApproval(approved, { type: "reject" }),
		ApprovalConflictError,
	);

	const rejected = transitionApproval(waiting, { type: "reject" });
	assert.equal(transitionApproval(rejected, { type: "reject" }), rejected);
	assert.throws(
		() => transitionApproval(rejected, { type: "approve_once" }),
		ApprovalConflictError,
	);
});

test("effect claim and completion retries require matching identities", () => {
	const approved = transitionApproval(createWaitingApproval("decision-1"), {
		type: "approve_once",
	});
	const executing = transitionApproval(approved, {
		type: "claim_effect",
		fingerprint: "sha256:a",
	});
	assert.equal(
		transitionApproval(executing, { type: "claim_effect", fingerprint: "sha256:a" }),
		executing,
	);
	assert.throws(
		() => transitionApproval(executing, {
			type: "claim_effect",
			fingerprint: "sha256:b",
		}),
		ApprovalConflictError,
	);

	const completed = transitionApproval(executing, {
		type: "complete_effect",
		resultCallId: "result-1",
	});
	assert.equal(
		transitionApproval(completed, {
			type: "complete_effect",
			resultCallId: "result-1",
		}),
		completed,
	);
	assert.throws(
		() => transitionApproval(completed, {
			type: "complete_effect",
			resultCallId: "result-2",
		}),
		ApprovalConflictError,
	);
});

test("approval identities and effect fingerprints must be non-empty", () => {
	assert.throws(() => createWaitingApproval("  "), TypeError);
	const approved = transitionApproval(createWaitingApproval("decision-1"), {
		type: "approve_once",
	});
	assert.throws(
		() => transitionApproval(approved, { type: "claim_effect", fingerprint: "" }),
		TypeError,
	);
});
