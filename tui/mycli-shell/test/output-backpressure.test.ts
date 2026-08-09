import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OutputBackpressureTracker } from "../src/tui-core/output-backpressure.ts";

test("output backpressure remains blocked until drain", () => {
	const source = new EventEmitter();
	const tracker = new OutputBackpressureTracker(source);
	let drainCalls = 0;
	const unsubscribe = tracker.subscribe(() => {
		drainCalls += 1;
	});

	tracker.observeWrite(false);
	assert.equal(tracker.blocked, true);
	source.emit("drain");
	assert.equal(tracker.blocked, false);
	assert.equal(drainCalls, 1);

	unsubscribe();
	assert.equal(source.listenerCount("drain"), 0);
});

test("output backpressure waits for drain after the last subscriber leaves", () => {
	const source = new EventEmitter();
	const tracker = new OutputBackpressureTracker(source);
	let drainCalls = 0;
	const unsubscribe = tracker.subscribe(() => {
		drainCalls += 1;
	});

	tracker.observeWrite(false);
	unsubscribe();
	assert.equal(tracker.blocked, true);
	assert.equal(source.listenerCount("drain"), 1);

	source.emit("drain");
	assert.equal(tracker.blocked, false);
	assert.equal(drainCalls, 0);
	assert.equal(source.listenerCount("drain"), 0);
});
