import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadManagedExecutionPolicy } from "../src/index.ts";

test("managed execution policy is absent when no managed file exists", async (t) => {
	const homeDir = await temporaryHome(t);

	assert.equal(await loadManagedExecutionPolicy({ homeDir }), undefined);
});

test("managed execution policy loads an independent bounded constraint layer", async (t) => {
	const homeDir = await temporaryHome(t);
	const path = join(homeDir, ".mycli", "managed_config.toml");
	await writeToml(path, [
		"[execution_policy]",
		'network = "enabled"',
		`readable_roots = [${JSON.stringify(join(homeDir, "managed-input"))}]`,
		`writable_roots = [${JSON.stringify(join(homeDir, "managed-output"))}]`,
		'allowed_network_domains = ["API.Example.com.", "*.assets.example.com"]',
	]);

	const constraints = await loadManagedExecutionPolicy({ homeDir });

	assert.deepEqual(constraints, {
		source: "managed",
		network: "enabled",
		readableRoots: [join(homeDir, "managed-input")],
		writableRoots: [join(homeDir, "managed-output")],
		networkDomains: ["api.example.com", "*.assets.example.com"],
	});
	assert.equal(Object.isFrozen(constraints), true);
	assert.equal(Object.isFrozen(constraints?.networkDomains), true);
});

test("managed execution policy rejects malformed security fields", async (t) => {
	const homeDir = await temporaryHome(t);
	const path = join(homeDir, ".mycli", "managed_config.toml");
	for (const lines of [
		["[execution_policy]", 'network = "unrestricted"'],
		["[execution_policy]", 'writable_roots = "outside"'],
		["[execution_policy]", 'allowed_network_domains = [""]'],
		["[execution_policy]", 'allowed_network_domains = ["https://example.com"]'],
		["[execution_policy]", 'writable_root = "/tmp"'],
	]) {
		await writeToml(path, lines);
		await assert.rejects(
			() => loadManagedExecutionPolicy({ homeDir }),
			/config_error: invalid managed execution policy/u,
		);
	}
});

test("managed execution policy rejects malformed TOML", async (t) => {
	const homeDir = await temporaryHome(t);
	const path = join(homeDir, ".mycli", "managed_config.toml");
	await writeToml(path, ["[execution_policy"]);

	await assert.rejects(
		() => loadManagedExecutionPolicy({ homeDir }),
		/config_error: invalid TOML in managed config/u,
	);
});

async function temporaryHome(t: test.TestContext): Promise<string> {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-managed-policy-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	return homeDir;
}

async function writeToml(path: string, lines: readonly string[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}
