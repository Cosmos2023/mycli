import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionState, ExtensionRegistry } from "../src/index.ts";

test("session state outlives turns while turn state does not", () => {
	const state = createExtensionState();
	state.session.set("count", 1);
	assert.equal(state.session.get<number>("count"), 1);

	state.turn("turn-1").set("seen", "first");
	assert.equal(state.turn("turn-1").get<string>("seen"), "first");
	// Turns do not share a scope, and neither leaks into the session.
	assert.equal(state.turn("turn-2").get<string>("seen"), undefined);
	assert.equal(state.session.get<string>("seen"), undefined);

	state.endTurn("turn-1");
	assert.equal(state.turn("turn-1").get<string>("seen"), undefined);
	assert.equal(state.session.get<number>("count"), 1);
});

test("a scope keeps values by reference and reports what it holds", () => {
	const scope = createExtensionState().turn("turn-1");
	const value = { pending: true };
	assert.equal(scope.set("value", value), value);
	assert.equal(scope.get<typeof value>("value"), value);
	assert.equal(scope.has("value"), true);
	scope.delete("value");
	assert.equal(scope.has("value"), false);
	assert.equal(scope.get("value"), undefined);
});

test("the registry hands out the scopes but not the ability to end a turn", () => {
	const registry = new ExtensionRegistry();
	registry.state.turn("turn-1").set("marker", 1);
	assert.equal(registry.state.turn("turn-1").get<number>("marker"), 1);

	registry.endTurn("turn-1");
	assert.equal(registry.state.turn("turn-1").has("marker"), false);
	assert.equal("endTurn" in registry.state, false);
});
