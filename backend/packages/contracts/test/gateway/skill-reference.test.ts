import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillReferences, skillReferencesInText, type SkillReference } from "../../src/gateway/skill-reference.ts";

const skill: SkillReference = { id: "a".repeat(64), name: "plugin:review", revision: "b".repeat(64) };

test("skill references validate identity and track complete mentions", () => {
	assert.deepEqual(parseSkillReferences([skill]), [skill]);
	for (const text of ["$plugin:review", "Use $plugin:review please", "($plugin:review)"]) {
		assert.deepEqual(skillReferencesInText([skill], text), [skill]);
	}
	for (const text of ["plugin:review", "$plugin:review-other", "foo$plugin:review", ""]) {
		assert.deepEqual(skillReferencesInText([skill], text), []);
	}
	assert.throws(() => parseSkillReferences([skill, skill]), /Duplicate/);
	assert.throws(() => parseSkillReferences([{ ...skill, path: "/arbitrary" }]), /Invalid/);
	assert.throws(() => parseSkillReferences([{ ...skill, id: "forged" }]), /Invalid/);
});
