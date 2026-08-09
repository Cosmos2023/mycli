import assert from "node:assert/strict";
import test from "node:test";
import { FrameScheduler, type FrameSchedulerClock } from "../src/tui-core/frame-scheduler.ts";

class TestClock implements FrameSchedulerClock {
	private nowMs = 0;
	private nextId = 1;
	private timers = new Map<number, { at: number; callback: () => void }>();

	now(): number {
		return this.nowMs;
	}

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.nextId++;
		this.timers.set(id, { at: this.nowMs + Math.max(0, delayMs), callback });
		return id;
	}

	clearTimeout(timer: unknown): void {
		this.timers.delete(timer as number);
	}

	advanceBy(deltaMs: number): void {
		const target = this.nowMs + deltaMs;
		while (true) {
			const next = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
			if (!next) break;
			const [id, timer] = next;
			this.timers.delete(id);
			this.nowMs = timer.at;
			timer.callback();
		}
		this.nowMs = target;
	}
}

test("frame scheduler coalesces synchronous requests", () => {
	const clock = new TestClock();
	let frames = 0;
	const scheduler = new FrameScheduler(() => frames += 1, { minIntervalMs: 16, clock });

	scheduler.request();
	scheduler.request();
	scheduler.request();
	clock.advanceBy(0);

	assert.equal(frames, 1);
});

test("frame scheduler enforces the next frame deadline", () => {
	const clock = new TestClock();
	const frameTimes: number[] = [];
	const scheduler = new FrameScheduler(() => frameTimes.push(clock.now()), { minIntervalMs: 16, clock });

	scheduler.request();
	clock.advanceBy(0);
	scheduler.request();
	clock.advanceBy(15);
	assert.deepEqual(frameTimes, [0]);
	clock.advanceBy(1);

	assert.deepEqual(frameTimes, [0, 16]);
});

test("frame scheduler retains the latest request while paused or blocked", () => {
	const clock = new TestClock();
	let blocked = true;
	let frames = 0;
	const scheduler = new FrameScheduler(() => frames += 1, {
		minIntervalMs: 16,
		clock,
		isBlocked: () => blocked,
	});

	scheduler.request();
	clock.advanceBy(50);
	assert.equal(frames, 0);
	blocked = false;
	scheduler.notifyReady();
	clock.advanceBy(0);
	assert.equal(frames, 1);

	scheduler.setPaused(true);
	scheduler.request();
	clock.advanceBy(50);
	assert.equal(frames, 1);
	scheduler.setPaused(false);
	clock.advanceBy(0);
	assert.equal(frames, 2);
});

test("an immediate request replaces a pending rate-limited frame", () => {
	const clock = new TestClock();
	const frameTimes: number[] = [];
	const scheduler = new FrameScheduler(() => frameTimes.push(clock.now()), { minIntervalMs: 16, clock });

	scheduler.request();
	clock.advanceBy(0);
	clock.advanceBy(4);
	scheduler.request();
	scheduler.request(true);
	clock.advanceBy(0);
	clock.advanceBy(20);

	assert.deepEqual(frameTimes, [0, 4]);
});
