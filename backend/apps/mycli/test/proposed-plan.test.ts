import assert from "node:assert/strict";
import test from "node:test";
import {
	extractProposedPlan,
	ProposedPlanStreamFilter,
} from "../src/node-runtime/proposed-plan.ts";

test("extracts one standalone proposed-plan block and preserves surrounding text", () => {
	assert.deepEqual(
		extractProposedPlan("Before\r\n<proposed_plan>\r\n# Plan\r\n- Verify\r\n</proposed_plan>\r\nAfter"),
		{
			assistantText: "Before\r\nAfter",
			planText: "# Plan\r\n- Verify",
		},
	);
});

test("leaves inline, malformed, empty, and multiple proposed-plan blocks as ordinary text", () => {
	for (const text of [
		"Before <proposed_plan>inline</proposed_plan>",
		"<proposed_plan>\nmissing close",
		"</proposed_plan>\n<proposed_plan>\nwrong order",
		"<proposed_plan>\n\n</proposed_plan>",
		"<proposed_plan>\none\n</proposed_plan>\n<proposed_plan>\ntwo\n</proposed_plan>",
	]) {
		assert.equal(extractProposedPlan(text), undefined, text);
	}
});

test("stream filter suppresses a valid plan block split across arbitrary chunks", () => {
	const filter = new ProposedPlanStreamFilter();
	const visible = [
		filter.push("Before\n<pro"),
		filter.push("posed_plan>\r\n# Plan\r\n"),
		filter.push("- Verify\r\n</proposed_"),
		filter.push("plan>\r\nAfter"),
		filter.finishSegment(),
	].join("");

	assert.equal(visible, "Before\nAfter");
});

test("stream filter restores an unterminated plan candidate", () => {
	const filter = new ProposedPlanStreamFilter();
	const visible = [
		filter.push("Before\n<proposed_plan>\n# Plan\n"),
		filter.push("- Verify"),
		filter.finishSegment(),
	].join("");

	assert.equal(visible, "Before\n<proposed_plan>\n# Plan\n- Verify");
});
