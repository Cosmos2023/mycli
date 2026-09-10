import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	createSkillToolRegistration,
	skillInvocationArtifactFromMetadata,
	SkillRegistry,
	SkillTool,
} from "../../src/index.ts";

test("exposes one stable Skill definition regardless of discovered skill count", async (t) => {
	const empty = await registryFixture(t, []);
	const populated = await registryFixture(t, ["review", "analyze", "deploy"]);
	const emptyRegistration = createSkillToolRegistration(empty);
	const populatedRegistration = createSkillToolRegistration(populated);

	assert.equal([emptyRegistration].length, 1);
	assert.equal([populatedRegistration].length, 1);
	assert.deepEqual(emptyRegistration.definition, populatedRegistration.definition);
	assert.equal(populatedRegistration.definition.name, "Skill");
	assert.deepEqual(populatedRegistration.definition.inputSchema, {
		type: "object",
		properties: {
			name: {
				type: "string",
				minLength: 1,
				description: "Exact skill name from the model-visible skill catalog.",
			},
			reason: {
				type: "string",
				description: "Optional compatibility context for why the skill is being loaded; it does not affect skill selection.",
			},
		},
		required: ["name"],
		additionalProperties: false,
	});
});

test("returns a bounded host-only instruction artifact and a short model summary", async (t) => {
	const registry = await registryFixture(t, ["review"], "Prefer correctness risks first.");
	const tool = new SkillTool({ registry });

	const result = await tool.execute({ name: "review", reason: "Review requested" }, {
		signal: new AbortController().signal,
		ownerSessionId: "session-1",
		callId: "call-1",
		publishLifecycle: () => undefined,
	});

	const artifact = result.metadata.skillInvocationArtifact as Readonly<Record<string, unknown>>;
	assert.equal(result.success, true);
	assert.equal(result.modelOutput, "Activated skill: review");
	assert.equal(result.modelOutput.includes("Prefer correctness"), false);
	assert.deepEqual(artifact, {
		kind: "skill_instructions",
		name: "review",
		text: [
			'<loaded-skill name="review" source="repo">',
			"This is a loaded skill reference, not the current user request.",
			"Prefer correctness risks first.",
			"</loaded-skill>",
		].join("\n"),
		sourceKind: "repo",
		contentSha256: createHash("sha256")
			.update("Prefer correctness risks first.", "utf8")
			.digest("hex"),
		contentLength: "Prefer correctness risks first.".length,
	});
	assert.equal(Object.isFrozen(artifact), true);
});

test("returns skill_not_found without leaking registry details", async (t) => {
	const registry = await registryFixture(t, []);
	const result = await new SkillTool({ registry }).execute({ name: "missing" }, {
		signal: new AbortController().signal,
		ownerSessionId: "session-1",
		callId: "call-1",
		publishLifecycle: () => undefined,
	});

	assert.equal(result.success, false);
	assert.equal(result.errorKind, "skill_not_found");
	assert.equal(result.modelOutput, "Skill activation failed: skill_not_found");
	assert.deepEqual(result.metadata, {});
});

test("rejects malformed host-only skill artifacts at the runtime boundary", () => {
	const base = {
		kind: "skill_instructions",
		name: "review",
		text: "instructions",
		sourceKind: "repo",
		contentSha256: "a".repeat(64),
		contentLength: 12,
	};

	assert.deepEqual(
		skillInvocationArtifactFromMetadata({ skillInvocationArtifact: base }),
		base,
	);
	assert.equal(skillInvocationArtifactFromMetadata({
		skillInvocationArtifact: { ...base, sourceKind: "external" },
	}), undefined);
	assert.equal(skillInvocationArtifactFromMetadata({
		skillInvocationArtifact: { ...base, text: "x".repeat(131_073) },
	}), undefined);
	assert.equal(skillInvocationArtifactFromMetadata({
		skillInvocationArtifact: { ...base, contentLength: 65_537 },
	}), undefined);
});

async function registryFixture(
	t: TestContext,
	names: readonly string[],
	body = "Instructions",
): Promise<SkillRegistry> {
	const root = await mkdtemp(join(tmpdir(), "mycli-skill-tool-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const builtinRoot = join(root, "builtin");
	const userRoot = join(root, "user");
	const repoRoot = join(root, "repo");
	for (const directory of [builtinRoot, userRoot, repoRoot]) {
		await mkdir(directory, { recursive: true });
	}
	for (const name of names) {
		await writeFile(
			join(repoRoot, `${name}.md`),
			`---\nname = "${name}"\ndescription = "${name} instructions"\n---\n${body}\n`,
			"utf8",
		);
	}
	return SkillRegistry.discover({ builtinRoot, userRoot, repoRoot });
}
