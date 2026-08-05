import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { resolveConfig } from "../src/index.ts";

test("resolves CLI, environment, user, project, and legacy precedence", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".config", "mycli", "config.toml"), [
		'model = "legacy-model"',
		'request_max_retries = 1',
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		'model = "project-model"',
		'request_max_retries = 2',
	]);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		'provider = "openai"',
		'name = "user-model"',
		"[request]",
		"request_max_retries = 3",
		"stream_max_retries = 120",
		"[reasoning]",
		'effort = "high"',
	]);

	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MODEL: "env-model", MYCLI_REQUEST_MAX_RETRIES: "-1" },
		overrides: { model: "cli-model", session: "session-1" },
	});

	assert.equal(resolved.model, "cli-model");
	assert.equal(resolved.provider, "openai");
	assert.equal(resolved.protocol, "responses");
	assert.equal(resolved.requestMaxRetries, 0);
	assert.equal(resolved.streamMaxRetries, 100);
	assert.equal(resolved.reasoningEffort, "high");
	assert.equal(resolved.sessionId, "session-1");
	assert.equal(resolved.sessionsDbPath, join(homeDir, ".mycli", "sessions.db"));
});

test("auth store outranks legacy inline config keys", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		'provider = "compatible"',
		'protocol = "chat_completions"',
		'model = "chat-model"',
		'auth_ref = "private-endpoint"',
		'api_key = "inline-secret"',
	]);
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "auth.json"), JSON.stringify({
		"private-endpoint": { type: "api_key", key: "stored-secret" },
	}), "utf8");

	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: {},
		createSessionId: () => "generated-session",
	});

	assert.equal(resolved.apiKey, "stored-secret");
	assert.equal(resolved.authRef, "private-endpoint");
	assert.equal(resolved.sessionId, "generated-session");
});

test("legacy transport retry limit feeds the stream retry setting", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), ["transport_retry_limit = 7"]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });
	assert.equal(resolved.streamMaxRetries, 7);
});

test("loads Python-compatible compaction and memory defaults", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });

	assert.equal(resolved.memoryEnabled, true);
	assert.equal(resolved.compressionThresholdTokens, 8_000);
	assert.equal(resolved.compactionTokenLimit, 9_600);
	assert.equal(resolved.compactionReservedOutputTokens, 13_000);
	assert.equal(resolved.compactionTailTurns, 2);
	assert.equal(resolved.compactionTailMaxTokens, 8_000);
	assert.equal(resolved.compactionTriggerRatio, 0.9);
	assert.equal(resolved.compactionBufferTokens, 13_000);
	assert.equal(resolved.compactionMinSavingsRatio, undefined);
	assert.equal(resolved.compactionExpectedSummaryTokens, 500);
	assert.equal(resolved.compactionCarryTurns, 1);
	assert.equal(resolved.compactionSummarizerModel, undefined);
	assert.deepEqual(resolved.compactionTriggerRatiosByModel, {});
	assert.equal(resolved.compactionRehydrationFileMaxTotalTokens, 50_000);
	assert.equal(resolved.compactionRehydrationFileMaxItemTokens, 5_000);
	assert.equal(resolved.compactionRehydrationMaxFiles, 5);
});

test("loads the Python-compatible sectioned memory toggle", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[memory]",
		"enabled = false",
	]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });

	assert.equal(resolved.memoryEnabled, false);
});

test("loads sectioned compaction settings and model ratios", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[request]",
		"max_prompt_tokens = 100000",
		"[context]",
		"compaction_token_limit = 87000",
		"compaction_reserved_output_tokens = 13000",
		"compaction_tail_turns = 3",
		"compaction_tail_max_tokens = 7000",
		"compaction_l4_trigger_ratio = 0.82",
		"compaction_l4_buffer_tokens = 9000",
		"compaction_l4_min_savings_ratio = 0.2",
		"compaction_l4_expected_summary_tokens = 300",
		"compaction_l4_carry_turns = 4",
		'compaction_l4_summarizer_model = "summary-model"',
		"compaction_rehydration_file_max_total_tokens = 12000",
		"compaction_rehydration_file_max_item_tokens = 2000",
		"compaction_rehydration_max_files = 3",
		"[compaction_l4_trigger_ratios_by_model]",
		'"gpt-5" = 0.75',
		'"chat-model" = 0.8',
	]);

	const resolved = await resolveConfig({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MEMORY_ENABLED: "false" },
	});

	assert.equal(resolved.memoryEnabled, false);
	assert.equal(resolved.compactionTokenLimit, 87_000);
	assert.equal(resolved.compactionReservedOutputTokens, 13_000);
	assert.equal(resolved.compactionTailTurns, 3);
	assert.equal(resolved.compactionTailMaxTokens, 7_000);
	assert.equal(resolved.compactionTriggerRatio, 0.82);
	assert.equal(resolved.compactionBufferTokens, 9_000);
	assert.equal(resolved.compactionMinSavingsRatio, 0.2);
	assert.equal(resolved.compactionExpectedSummaryTokens, 300);
	assert.equal(resolved.compactionCarryTurns, 4);
	assert.equal(resolved.compactionSummarizerModel, "summary-model");
	assert.deepEqual(resolved.compactionTriggerRatiosByModel, {
		"chat-model": 0.8,
		"gpt-5": 0.75,
	});
	assert.equal(resolved.compactionRehydrationFileMaxTotalTokens, 12_000);
	assert.equal(resolved.compactionRehydrationFileMaxItemTokens, 2_000);
	assert.equal(resolved.compactionRehydrationMaxFiles, 3);
});

test("falls through an empty user model-ratio table to project settings", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"[compaction_l4_trigger_ratios_by_model]",
	]);
	await writeToml(join(workspaceRoot, ".mycli", "config.toml"), [
		"[compaction_l4_trigger_ratios_by_model]",
		'"project-model" = 0.72',
	]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });

	assert.deepEqual(resolved.compactionTriggerRatiosByModel, {
		"project-model": 0.72,
	});
});

test("rejects invalid compaction ranges before a turn starts", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"compaction_l4_trigger_ratio = 1.1",
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		/error: compaction_l4_trigger_ratio must be between 0 and 1/,
	);
});

test("accepts zero as an explicit minimum compaction savings ratio", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"compaction_l4_min_savings_ratio = 0",
	]);

	const resolved = await resolveConfig({ homeDir, workspaceRoot, env: {} });
	assert.equal(resolved.compactionMinSavingsRatio, 0);
});

test("rejects an impossible rehydration item budget", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"compaction_rehydration_file_max_total_tokens = 100",
		"compaction_rehydration_file_max_item_tokens = 101",
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		/error: compaction_rehydration_file_max_item_tokens cannot exceed total tokens/,
	);
});

test("rejects a compaction threshold above the prompt window", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), [
		"max_prompt_tokens = 12000",
		"compaction_token_limit = 12001",
	]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		/error: compaction_token_limit cannot exceed max_prompt_tokens/,
	);
});

test("malformed TOML raises a bounded config error", async (t) => {
	const { homeDir, workspaceRoot } = await configTree(t);
	await writeToml(join(homeDir, ".mycli", "config.toml"), ["[broken"]);

	await assert.rejects(
		() => resolveConfig({ homeDir, workspaceRoot, env: {} }),
		(error: unknown) => error instanceof Error
			&& /^config_error: invalid TOML in user config$/.test(error.message),
	);
});

async function configTree(t: TestContext): Promise<{ homeDir: string; workspaceRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-settings-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await mkdir(homeDir, { recursive: true });
	await mkdir(workspaceRoot, { recursive: true });
	t.after(() => rm(root, { recursive: true, force: true }));
	return { homeDir, workspaceRoot };
}

async function writeToml(path: string, lines: readonly string[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}
