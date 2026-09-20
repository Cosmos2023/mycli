import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadManagedExecutionPolicy } from "../../src/index.ts";

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
		`readonly_roots = [${JSON.stringify(join(homeDir, "vendor"))}]`,
		"allow_local_binding = true",
		"writable_tmp = false",
	]);

	const constraints = await loadManagedExecutionPolicy({ homeDir });

	assert.deepEqual(constraints, {
		source: "managed",
		network: "enabled",
		readableRoots: [join(homeDir, "managed-input")],
		writableRoots: [join(homeDir, "managed-output")],
		networkDomains: ["api.example.com", "*.assets.example.com"],
		readOnlyRoots: [join(homeDir, "vendor")], allowLocalBinding: true, writableTemp: false,
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
		["[execution_policy]", 'allow_local_binding = "true"'],
		["[execution_policy]", 'writable_tmp = 1'],
		["[execution_policy]", 'readonly_roots = ["relative"]'],
	]) {
		await writeToml(path, lines);
		await assert.rejects(
			() => loadManagedExecutionPolicy({ homeDir }),
			/config_error: invalid managed execution policy/u,
		);
	}
});

test("managed execution policy loads structured egress rules and rejects contradictions", async (t) => {
	const homeDir = await temporaryHome(t);
	const path = join(homeDir, ".mycli", "managed_config.toml");
	await writeToml(path, [
		"[execution_policy]",
		'network = "enabled"',
		"[execution_policy.network_egress]",
		'default = "deny"',
		"[[execution_policy.network_egress.allow]]",
		'to = [{ cidr = "10.0.0.0/8", except = ["10.1.0.0/16"] }]',
		'ports = [{ protocol = "tcp", port = 443, end_port = 444 }]',
	]);
	const constraints = await loadManagedExecutionPolicy({ homeDir });
	assert.deepEqual(constraints?.networkEgress, {
		default: "deny",
		allow: [{
			to: [{ cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] }],
			ports: [{ protocol: "tcp", port: 443, endPort: 444 }],
		}],
	});
	assert.equal(Object.isFrozen(constraints?.networkEgress), true);

	for (const invalid of [
		[
			"[execution_policy]",
			'network = "enabled"',
			"[execution_policy.network_egress]",
			'default = "allow"',
			"[[execution_policy.network_egress.allow]]",
			'to = [{ cidr = "10.0.0.0/8" }]',
		],
		[
			"[execution_policy]",
			'network = "enabled"',
			"[execution_policy.network_egress]",
			'default = "deny"',
			"[[execution_policy.network_egress.allow]]",
			'to = [{ cidr = "10.0.0.0" }]',
		],
		[
			"[execution_policy]",
			'network = "enabled"',
			'allowed_network_domains = ["api.example.com"]',
			"[execution_policy.network_egress]",
			'default = "deny"',
			"[[execution_policy.network_egress.allow]]",
			'to = [{ cidr = "10.0.0.0/8" }]',
		],
		[
			"[execution_policy]",
			'network = "disabled"',
			"[execution_policy.network_egress]",
			'default = "deny"',
			"[[execution_policy.network_egress.allow]]",
			'to = [{ cidr = "10.0.0.0/8" }]',
		],
	]) {
		await writeToml(path, invalid);
		await assert.rejects(loadManagedExecutionPolicy({ homeDir }),
			/config_error: invalid managed execution policy/u);
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

test("managed denied reads are immutable independent constraints with strict paths", async (t) => {
	const homeDir = await temporaryHome(t);
	const path = join(homeDir, ".mycli", "managed_config.toml");
	await writeToml(path, ["[execution_policy]", `denied_read_roots = [${JSON.stringify(join(homeDir, "private"))}]`, 'denied_read_globs = ["**/.env", "**/.env"]']);
	const policy = await loadManagedExecutionPolicy({ homeDir });
	assert.deepEqual(policy, { source: "managed", deniedReadRoots: [join(homeDir, "private")], deniedReadGlobs: ["**/.env"] });
	assert.equal(Object.isFrozen(policy?.deniedReadRoots), true);
	assert.equal(Object.isFrozen(policy?.deniedReadGlobs), true);
	for (const line of ['denied_read_roots = ["relative"]', 'denied_read_globs = ["../secret"]', 'denied_read_globs = true']) {
		await writeToml(path, ["[execution_policy]", line]);
		await assert.rejects(loadManagedExecutionPolicy({ homeDir }), /config_error/u);
	}
});
