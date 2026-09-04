import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "@mycli/core";
import { ActiveToolExecutionRegistry } from "../src/active-tool-execution-registry.ts";
import type { RuntimeDiagnosticEvent } from "../src/runtime-observability.ts";

test("active tool registry owns start completion and bounded diagnostics", () => {
	let now = 10;
	const events: RuntimeEvent[] = [];
	const diagnostics: RuntimeDiagnosticEvent[] = [];
	const registry = new ActiveToolExecutionRegistry({
		clock: () => now,
		recordDiagnostic: (event) => { diagnostics.push(event); },
	});
	const claim = registry.begin({
		turnId: "turn-1",
		callId: "call-1",
		toolName: "Read",
		interruptErrorKind: "tool_interrupted",
	}, (event) => { events.push(event); });

	now = 26;
	assert.equal(registry.complete(claim, {
		callId: "call-1",
		toolName: "Read",
		success: true,
		modelOutput: "ok",
		summary: "Read complete",
		metadata: Object.freeze({}),
	}, (event) => { events.push(event); }), true);
	assert.equal(registry.complete(claim, {
		callId: "call-1",
		toolName: "Read",
		success: true,
		modelOutput: "late",
		summary: "late",
		metadata: Object.freeze({}),
	}, (event) => { events.push(event); }), false);
	assert.deepEqual(events.map((event) => event.type), [
		"tool_execution_started",
		"tool_execution_completed",
	]);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0]?.kind, "tool_execution");
	if (diagnostics[0]?.kind === "tool_execution") {
		assert.equal(diagnostics[0].durationMs, 16);
	}
	assert.equal(claim.signal.aborted, false);
});

test("active tool registry requires exact claims across reused call ids", () => {
	const events: RuntimeEvent[] = [];
	const emit = (event: RuntimeEvent): void => { events.push(event); };
	const registry = new ActiveToolExecutionRegistry();
	const first = registry.begin({
		turnId: "turn-1",
		callId: "call-reused",
		toolName: "Write",
		interruptErrorKind: "effect_outcome_unknown",
	}, emit);
	assert.throws(() => registry.begin({
		turnId: "turn-1",
		callId: "call-reused",
		toolName: "Write",
		interruptErrorKind: "effect_outcome_unknown",
	}, emit), /already active/u);
	assert.equal(registry.interrupt(first, emit), true);

	const replacement = registry.begin({
		turnId: "turn-1",
		callId: "call-reused",
		toolName: "Write",
		interruptErrorKind: "effect_outcome_unknown",
	}, emit);
	assert.equal(registry.fail(first, "tool_execution_failed", emit), false);
	assert.equal(registry.fail(replacement, "tool_execution_failed", emit), true);
	assert.equal(events.filter((event) => event.type === "tool_execution_failed").length, 2);
});

test("active tool registry interrupts every full-id claim exactly once", () => {
	const events: RuntimeEvent[] = [];
	const registry = new ActiveToolExecutionRegistry();
	const sharedPrefix = "x".repeat(256);
	const first = registry.begin({
		turnId: "turn-parallel",
		callId: `${sharedPrefix}-a`,
		toolName: "Shell",
		interruptErrorKind: "tool_interrupted",
	}, (event) => { events.push(event); });
	const second = registry.begin({
		turnId: "turn-parallel",
		callId: `${sharedPrefix}-b`,
		toolName: "Shell",
		interruptErrorKind: "tool_interrupted",
	}, (event) => { events.push(event); });

	assert.equal(registry.interruptTurn("turn-parallel", (event) => { events.push(event); }), 2);
	assert.equal(first.signal.aborted, true);
	assert.equal(second.signal.aborted, true);
	assert.equal(registry.interruptTurn("turn-parallel", (event) => { events.push(event); }), 0);
	assert.equal(events.filter((event) => event.type === "tool_execution_failed").length, 2);
});
