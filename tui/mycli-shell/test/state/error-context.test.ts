import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseErrorContext, TURN_INTERRUPTED_NOTICE } from "@mycli/contracts";
import { appendErrorNotice, appendInterruptedNotice, noticeDiagnostic } from "../../src/state/transcript-messages.ts";
import { NoticeMessageComponent } from "../../src/components/transcript/notice-message.ts";
import { visibleWidth } from "../../src/tui-core/utils.ts";

const bytes = readFileSync(new URL("../../../../tests/fixtures/error-system/failures.json", import.meta.url));
const fixtures = JSON.parse(bytes.toString("utf8")) as { context: unknown; code: string; summary: string; recovery: string[] }[];

test("TUI consumes the same hashed error fixtures as backend", () => {
	const digest = readFileSync(new URL("../../../../tests/fixtures/error-system/failures.sha256", import.meta.url), "utf8").trim();
	assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
	for (const fixture of fixtures) {
		const context = parseErrorContext(fixture.context);
		const params = { code: fixture.code, error_context: context, recovery_actions: fixture.recovery };
		const item = appendErrorNotice([], params, "old summary")[0]!;
		assert.equal(item.text, fixture.summary);
		const diagnostic = noticeDiagnostic(item.metadata).diagnostic;
		assert.deepEqual(diagnostic?.errorContext, context);
		const component = new NoticeMessageComponent({ id: item.id, role: "error", text: item.text, diagnostic });
		for (const width of [24, 80, 160]) {
			const lines = component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.equal(lines.join("\n").includes(context.id), false);
		}
		const details = new NoticeMessageComponent({ id: item.id, role: "error", text: item.text, diagnostic: { ...diagnostic, expanded: true } });
		assert.ok(details.render(160).join("\n").includes(context.reason));
	}
});

test("interruption identity survives repeated delivery and identical notices from distinct turns", () => {
	let items = appendInterruptedNotice([], { turn_id: "turn:1" });
	items = appendInterruptedNotice(items, { turn_id: "turn:1" });
	items = appendInterruptedNotice(items, { turn_id: "turn:2" });
	assert.equal(items.length, 2);
	assert.ok(items.every((item) => item.text === TURN_INTERRUPTED_NOTICE));
});

test("unknown error extensions never imply a configuration fix or automatic retry", () => {
	const fixture = parseErrorContext(fixtures[0]!.context);
	const diagnostic = noticeDiagnostic({ code: "connection_error", error_context: { ...fixture, version: 2 }, recovery_actions: ["retry"] }).diagnostic;
	assert.equal(diagnostic?.hint, undefined);
	assert.equal(diagnostic?.recoveryActions, undefined);
});
