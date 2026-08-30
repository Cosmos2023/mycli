import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "smol-toml";
import {
	isConfigError,
	mutateUserConfigSetting,
	resolveConfigWithMetadata,
} from "../src/index.ts";

test("user config mutation preserves formatting and replaces a colliding legacy model key", async (t) => {
	const root = await temporaryRoot(t);
	const path = await writeConfig(root.homeDir, [
		"# keep this comment",
		'model = "legacy-model"',
		"",
		"[other]",
		"value = 1 # keep inline comment",
		"",
	].join("\r\n"));

	const first = await mutate(root, "set", "model.name", "gpt-5.6-sol");
	const raw = await readFile(path, "utf8");
	const payload = parse(raw) as Record<string, unknown>;

	assert.deepEqual(first, { key: "model.name", changed: true });
	assert.match(raw, /# keep this comment\r\n/u);
	assert.match(raw, /value = 1 # keep inline comment\r\n/u);
	assert.equal(raw.includes("\n") && !raw.includes("\r\n"), false);
	assert.deepEqual(payload.model, { name: "gpt-5.6-sol" });
	assert.deepEqual(payload.other, { value: 1 });
	if (process.platform !== "win32") {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(root.homeDir, ".mycli"))).mode & 0o777, 0o700);
	}

	const before = await readFile(path, "utf8");
	const second = await mutate(root, "set", "model.name", "gpt-5.6-sol");
	assert.deepEqual(second, { key: "model.name", changed: false });
	assert.equal(await readFile(path, "utf8"), before);
});

test("user config mutation clears canonical and legacy aliases without changing unrelated values", async (t) => {
	const root = await temporaryRoot(t);
	const path = await writeConfig(root.homeDir, [
		"transport_retry_limit = 3",
		"custom_flag = true",
		"",
		"[request]",
		"request_max_retries = 2",
		"",
	].join("\n"));

	assert.deepEqual(
		await mutate(root, "set", "request.stream_max_retries", "7"),
		{ key: "request.stream_max_retries", changed: true },
	);
	let payload = parse(await readFile(path, "utf8")) as Record<string, unknown>;
	assert.equal(payload.transport_retry_limit, undefined);
	assert.deepEqual(payload.request, { request_max_retries: 2, stream_max_retries: 7 });
	assert.equal(payload.custom_flag, true);

	assert.deepEqual(
		await mutate(root, "unset", "request.stream_max_retries"),
		{ key: "request.stream_max_retries", changed: true },
	);
	payload = parse(await readFile(path, "utf8")) as Record<string, unknown>;
	assert.equal(payload.transport_retry_limit, undefined);
	assert.deepEqual(payload.request, { request_max_retries: 2 });
	assert.equal(payload.custom_flag, true);
	assert.deepEqual(
		await mutate(root, "unset", "request.stream_max_retries"),
		{ key: "request.stream_max_retries", changed: false },
	);
});

test("user config mutation validates typed and cross-field candidates before replacement", async (t) => {
	const root = await temporaryRoot(t);
	const path = await writeConfig(root.homeDir, [
		"[context]",
		"compaction_token_limit = 11000",
		"",
		"[request]",
		"max_prompt_tokens = 12000",
		"",
	].join("\n"));
	const before = await readFile(path, "utf8");

	for (const request of [
		["set", "memory.enabled", "private-value-sentinel"],
		["set", "request.request_max_retries", "1.5"],
		["set", "context.compaction_l4_trigger_ratio", "0x1"],
		["set", "request.max_prompt_tokens", "10000"],
		["set", "model.web_search_mode", "live"],
		["set", "api_key", "private-value-sentinel"],
		["set", "unknown.private-value-sentinel", "private-value-sentinel"],
	] as const) {
		await assert.rejects(
			() => mutate(root, request[0], request[1], request[2]),
			(error: unknown) => {
				assert.equal(isConfigError(error), true);
				const serialized = JSON.stringify(error);
				assert.doesNotMatch(serialized, /private-value-sentinel/u);
				return true;
			},
		);
		assert.equal(await readFile(path, "utf8"), before);
	}
});

test("user config mutation validates the candidate with enabled higher layers", async (t) => {
	const root = await temporaryRoot(t);
	const path = await writeConfig(root.homeDir, "# unchanged\n");
	const before = await readFile(path, "utf8");

	await assert.rejects(
		() => mutateUserConfigSetting({
			...root,
			env: { MYCLI_MAX_PROMPT_TOKENS: "10000" },
			workspaceTrust: "untrusted",
			action: "set",
			key: "context.compaction_token_limit",
			value: "11000",
		}),
		(error: unknown) => isConfigError(error),
	);
	assert.equal(await readFile(path, "utf8"), before);
});

test("concurrent user config mutations serialize without losing either update", async (t) => {
	const root = await temporaryRoot(t);

	const [memory, cache] = await Promise.all([
		mutate(root, "set", "memory.enabled", "true"),
		mutate(root, "set", "request.cache_control_enabled", "true"),
	]);
	assert.equal(memory.changed, true);
	assert.equal(cache.changed, true);
	const raw = await readFile(join(root.homeDir, ".mycli", "config.toml"), "utf8");
	const payload = parse(raw) as Record<string, unknown>;
	assert.deepEqual(payload.memory, { enabled: true });
	assert.deepEqual(payload.request, { cache_control_enabled: true });

	const resolved = await resolveConfigWithMetadata({
		...root,
		env: {},
		workspaceTrust: "untrusted",
	});
	assert.equal(resolved.config.memoryEnabled, true);
	assert.equal(resolved.config.cacheControlEnabled, true);
});

async function mutate(
	root: Readonly<{ homeDir: string; workspaceRoot: string }>,
	action: "set" | "unset",
	key: string,
	value?: string,
) {
	return mutateUserConfigSetting({
		...root,
		env: {},
		workspaceTrust: "untrusted",
		action,
		key,
		...(value === undefined ? {} : { value }),
	});
}

async function writeConfig(homeDir: string, content: string): Promise<string> {
	const directory = join(homeDir, ".mycli");
	const path = join(directory, "config.toml");
	await mkdir(directory, { recursive: true });
	await writeFile(path, content, "utf8");
	return path;
}

async function temporaryRoot(t: TestContext): Promise<{
	readonly homeDir: string;
	readonly workspaceRoot: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-editor-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await Promise.all([mkdir(homeDir), mkdir(workspaceRoot)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	return { homeDir, workspaceRoot };
}
