import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ConfigManagementService,
	type ConfigShowResponse,
} from "../src/management/config.ts";
import { renderManagementResponse } from "../src/management/render.ts";
import { createDefaultManagementServices } from "../src/management/services.ts";

test("config show reports bounded defaults without creating user files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-show-defaults-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "unknown",
	});

	const response = await service.show(new AbortController().signal);

	assert.equal(response.ok, true);
	assert.equal(response.version, 1);
	assert.equal(response.workspaceTrust, "unknown");
	assert.deepEqual(response.credentials, { apiKey: "missing" });
	assert.equal(setting(response, "model.provider").source, "default");
	assert.equal(setting(response, "model.provider").value, "openai");
	assert.deepEqual(response.layers.find((layer) => layer.id === "project"), {
		id: "project",
		scope: "project",
		enabled: false,
		disabledReason: "workspace_not_trusted",
	});
	assert.equal(JSON.stringify(response).includes(homeDir), false);
	await assert.rejects(access(join(homeDir, ".mycli")));
});

test("config show reports winners and overridden layers without credential values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-show-origins-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const sentinel = "sk-private-config-sentinel";
	await Promise.all([
		mkdir(join(homeDir, ".mycli"), { recursive: true }),
		mkdir(join(workspaceRoot, ".mycli"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(homeDir, ".mycli", "config.toml"), [
			"[model]",
			'provider = "openai"',
			'name = "user-model"',
			'api_base_url = "https://name:password@example.com/v1?api_key=hidden"',
			"",
		].join("\n"), "utf8"),
		writeFile(join(workspaceRoot, ".mycli", "config.toml"), [
			"[model]",
			'name = "project-model"',
			"",
		].join("\n"), "utf8"),
	]);
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MODEL: "environment-model", MYCLI_API_KEY: sentinel },
		workspaceTrust: "trusted",
	});

	const response = await service.show(new AbortController().signal);
	const model = setting(response, "model.name");
	const baseUrl = setting(response, "model.api_base_url");
	const serialized = JSON.stringify(response);
	const rendered = renderManagementResponse(
		{ kind: "config", action: "show", json: false },
		response,
	);

	assert.deepEqual(model, {
		key: "model.name",
		value: "environment-model",
		source: "environment",
		overridden: ["project", "user"],
	});
	assert.deepEqual(baseUrl, {
		key: "model.api_base_url",
		value: "https://example.com/v1",
		source: "user",
		overridden: [],
	});
	assert.deepEqual(response.credentials, { apiKey: "present" });
	for (const forbidden of [sentinel, "password", "api_key=hidden", homeDir, workspaceRoot]) {
		assert.equal(serialized.includes(forbidden), false);
		assert.equal(rendered.includes(forbidden), false);
	}
	assert.match(rendered, /setting model\.name=environment-model source=environment overridden=project,user/u);
	assert.equal(serialized.includes('"source":"/'), false);
});

test("config validate keeps unknown keys as value-free warnings", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-validate-warning-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const sentinel = "unknown-value-must-not-leak";
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		`nmae = "${sentinel}"`,
		"",
	].join("\n"), "utf8");
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "unknown",
	});

	const response = await service.validate(new AbortController().signal);

	assert.equal(response.ok, true);
	assert.equal(response.message, "configuration valid with warnings");
	assert.deepEqual(response.diagnostics.map((diagnostic) => ({
		code: diagnostic.code,
		severity: diagnostic.severity,
		layer: diagnostic.layer,
		keyPath: diagnostic.keyPath,
	})), [{
		code: "unknown_key",
		severity: "warning",
		layer: "user",
		keyPath: "model.nmae",
	}]);
	assert.equal(JSON.stringify(response).includes(sentinel), false);
});

test("config management does not read malformed untrusted project config", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-untrusted-project-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await mkdir(join(workspaceRoot, ".mycli"), { recursive: true });
	await writeFile(join(workspaceRoot, ".mycli", "config.toml"), "[model\nsecret = true", "utf8");
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "untrusted",
	});

	const response = await service.show(new AbortController().signal);

	assert.equal(response.ok, true);
	assert.deepEqual(response.diagnostics, []);
	assert.equal(response.layers.find((layer) => layer.id === "project")?.enabled, false);
});

test("default config management maps fatal diagnostics to exit one", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-invalid-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "config.toml"), "[model\nname = 'broken'", "utf8");
	t.after(() => rm(root, { recursive: true, force: true }));
	const services = await createDefaultManagementServices({ homeDir, workspaceRoot, env: {} });

	const response = await services.execute({
		kind: "config",
		action: "validate",
		json: true,
	});

	assert.equal(response.ok, false);
	assert.equal(response.exitCode, 1);
	assert.equal(response.message, "configuration invalid");
	assert.deepEqual(response.issues, ["invalid_toml"]);
	assert.equal(JSON.stringify(response).includes(homeDir), false);
});

test("config management maps invalid resolved values without echoing them", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-invalid-value-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const sentinel = "unsupported-provider-private-sentinel";
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await writeFile(join(homeDir, ".mycli", "config.toml"), [
		"[model]",
		`provider = "${sentinel}"`,
		"",
	].join("\n"), "utf8");
	t.after(() => rm(root, { recursive: true, force: true }));
	const services = await createDefaultManagementServices({ homeDir, workspaceRoot, env: {} });

	const response = await services.execute({
		kind: "config",
		action: "show",
		json: true,
	});

	assert.equal(response.ok, false);
	assert.deepEqual(response.issues, ["invalid_value"]);
	assert.equal(JSON.stringify(response).includes(sentinel), false);
});

function setting(response: ConfigShowResponse, key: string) {
	const row = response.settings.find((candidate) => candidate.key === key);
	assert.ok(row, `missing config setting: ${key}`);
	return row;
}
