import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { parseConfigProfileName } from "@mycli/config";
import {
	ConfigManagementService,
	type ConfigMigrationResponse,
	type ConfigPathResponse,
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
	assert.deepEqual(setting(response, "tui.theme"), {
		key: "tui.theme",
		value: "dark",
		source: "default",
		overridden: [],
	});
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

test("config show reports profile and system provenance for visual settings", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-profile-visual-settings-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const systemConfigPath = join(root, "machine", "config.toml");
	await Promise.all([
		mkdir(join(homeDir, ".mycli"), { recursive: true }),
		mkdir(workspaceRoot, { recursive: true }),
		mkdir(join(root, "machine"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(homeDir, ".mycli", "config.toml"), 'tui_theme = "dark"\n', "utf8"),
		writeFile(join(homeDir, ".mycli", "work.config.toml"), 'tui_theme = "light"\n', "utf8"),
		writeFile(systemConfigPath, 'tui_theme = "dark"\n', "utf8"),
	]);
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "untrusted",
		configProfile: parseConfigProfileName("work"),
		systemConfigPath,
	});

	assert.deepEqual(
		setting(await service.show(new AbortController().signal), "tui.theme"),
		{
			key: "tui.theme",
			value: "light",
			source: "profile",
			overridden: ["user", "system"],
		},
	);
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

	const strict = await service.validate(true, new AbortController().signal);
	assert.equal(strict.ok, false);
	assert.equal(strict.exitCode, 1);
	assert.deepEqual(strict.issues, ["strict_validation_failed"]);
	assert.equal(JSON.stringify(strict).includes(sentinel), false);
});

test("config path resolves every supported scope and renders text and JSON", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-path-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const systemConfigPath = join(root, "machine", "config.toml");
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "unknown",
		systemConfigPath,
	});
	const signal = new AbortController().signal;
	const scenarios = [
		["user", undefined, join(homeDir, ".mycli", "config.toml"), true],
		["project", undefined, join(workspaceRoot, ".mycli", "config.toml"), false],
		["profile", "work", join(homeDir, ".mycli", "work.config.toml"), false],
		["system", undefined, systemConfigPath, false],
		["legacy_user", undefined, join(homeDir, ".config", "mycli", "config.toml"), false],
	] as const;

	for (const [scope, profile, expectedPath, writable] of scenarios) {
		const response = await service.path(scope, profile, signal);
		assert.deepEqual({
			scope: response.scope,
			path: response.path,
			writable: response.writable,
		}, { scope, path: expectedPath, writable });
	}
	const profile = await service.path("profile", "work", signal);
	const command = {
		kind: "config",
		action: "path",
		scope: "profile",
		profile: "work",
		json: false,
	} as const;
	assert.match(
		renderManagementResponse(command, profile),
		new RegExp(`mycli config path\\nscope=profile\\npath=${escapeRegExp(JSON.stringify(profile.path))}`),
	);
	assert.deepEqual(
		JSON.parse(renderManagementResponse({ ...command, json: true }, profile)) as ConfigPathResponse,
		profile,
	);
	await assert.rejects(
		() => service.path("profile", "../private-profile-sentinel", signal),
		/ configuration invalid/u,
	);
});

test("config migration completes provider-free preview apply and rollback with redacted output", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-management-migration-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const userDirectory = join(homeDir, ".mycli");
	const legacyDirectory = join(homeDir, ".config", "mycli");
	const userPath = join(userDirectory, "config.toml");
	const legacyPath = join(legacyDirectory, "config.toml");
	const authPath = join(userDirectory, "auth.json");
	const before = '# preserve\r\nmodel = "private-model-sentinel"\r\n';
	const legacy = "memory_enabled = true\n";
	const auth = '{"openai":"private-auth-sentinel"}\n';
	await Promise.all([
		mkdir(userDirectory, { recursive: true }),
		mkdir(legacyDirectory, { recursive: true }),
		mkdir(workspaceRoot, { recursive: true }),
	]);
	await Promise.all([
		writeFile(userPath, before, "utf8"),
		writeFile(legacyPath, legacy, "utf8"),
		writeFile(authPath, auth, "utf8"),
	]);
	t.after(() => rm(root, { recursive: true, force: true }));
	const services = await createDefaultManagementServices({ homeDir, workspaceRoot, env: {} });

	const previewCommand = {
		kind: "config",
		action: "migrate",
		operation: "preview",
		json: false,
	} as const;
	const preview = await services.execute(previewCommand) as ConfigMigrationResponse;
	assert.equal(preview.ok, true);
	assert.equal(preview.needed, true);
	assert.ok(preview.expectedVersion);
	assert.equal(await readFile(userPath, "utf8"), before);
	const previewText = renderManagementResponse(previewCommand, preview);
	assert.match(previewText, /operation=preview\nneeded=true/u);
	assert.match(previewText, /change kind=(?:import|normalize) key=/u);
	assert.doesNotMatch(previewText, /private-(?:model|auth)-sentinel/u);

	const applyCommand = {
		kind: "config",
		action: "migrate",
		operation: "apply",
		expectedVersion: preview.expectedVersion,
		json: true,
	} as const;
	const applied = await services.execute(applyCommand) as ConfigMigrationResponse;
	assert.equal(applied.ok, true);
	assert.equal(applied.applied, true);
	assert.ok(applied.backupId);
	assert.deepEqual(parseToml(await readFile(userPath, "utf8")), {
		memory: { enabled: true },
		model: { name: "private-model-sentinel" },
	});
	assert.doesNotMatch(renderManagementResponse(applyCommand, applied), /private-(?:model|auth)-sentinel/u);

	const rollbackCommand = {
		kind: "config",
		action: "migrate",
		operation: "rollback",
		backupId: applied.backupId,
		json: false,
	} as const;
	const rollback = await services.execute(rollbackCommand) as ConfigMigrationResponse;
	assert.equal(rollback.ok, true);
	assert.equal(rollback.restored, true);
	assert.match(renderManagementResponse(rollbackCommand, rollback), /operation=rollback\nrestored=true/u);
	assert.equal(await readFile(userPath, "utf8"), before);
	assert.equal(await readFile(legacyPath, "utf8"), legacy);
	assert.equal(await readFile(authPath, "utf8"), auth);
});

test("config get set and unset report effective precedence without echoing submitted values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-mutation-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: { MYCLI_MEMORY_ENABLED: "false" },
		workspaceTrust: "untrusted",
	});

	const updated = await service.set(
		"memory.enabled",
		"true",
		new AbortController().signal,
	);
	const rendered = renderManagementResponse(
		{ kind: "config", action: "set", key: "memory.enabled", value: "true", json: false },
		updated,
	);
	assert.deepEqual({
		action: updated.action,
		key: updated.key,
		changed: updated.changed,
		effectiveSource: updated.effectiveSource,
		overridden: updated.overridden,
	}, {
		action: "set",
		key: "memory.enabled",
		changed: true,
		effectiveSource: "environment",
		overridden: ["user"],
	});
	assert.match(rendered, /key=memory\.enabled\nchanged=true\neffective_source=environment/u);
	assert.doesNotMatch(JSON.stringify(updated), /"value"/u);
	assert.deepEqual(
		(await service.get("memory.enabled", new AbortController().signal)).setting,
		{ key: "memory.enabled", value: false, source: "environment", overridden: ["user"] },
	);
	assert.deepEqual(
		parseToml(await readFile(join(homeDir, ".mycli", "config.toml"), "utf8")),
		{ memory: { enabled: true } },
	);

	const removed = await service.unset("memory.enabled", new AbortController().signal);
	assert.deepEqual({
		changed: removed.changed,
		effectiveSource: removed.effectiveSource,
		overridden: removed.overridden,
	}, { changed: true, effectiveSource: "environment", overridden: [] });
	const repeated = await service.unset("memory.enabled", new AbortController().signal);
	assert.equal(repeated.changed, false);
});

test("config mutation failures are typed and omit submitted values", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-mutation-invalid-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	const sentinel = "private-config-value-sentinel";
	t.after(() => rm(root, { recursive: true, force: true }));
	const services = await createDefaultManagementServices({ homeDir, workspaceRoot, env: {} });

	const command = {
		kind: "config",
		action: "set",
		key: "memory.enabled",
		value: sentinel,
		json: true,
	} as const;
	const response = await services.execute(command);

	assert.equal(response.ok, false);
	assert.equal(response.action, "set");
	assert.equal(response.exitCode, 1);
	assert.deepEqual(response.issues, ["invalid_value"]);
	assert.equal(JSON.stringify(response).includes(sentinel), false);
	assert.equal(renderManagementResponse({ ...command, json: false }, response).includes(sentinel), false);
	assert.equal(renderManagementResponse(command, response).includes(sentinel), false);

	const unknownKey = `unknown.${sentinel}`;
	const unknownResponse = await services.execute({
		...command,
		key: unknownKey,
		value: "true",
	});
	assert.equal(JSON.stringify(unknownResponse).includes(sentinel), false);
	assert.equal(renderManagementResponse({ ...command, key: unknownKey, json: false }, unknownResponse)
		.includes(sentinel), false);
	await assert.rejects(access(join(homeDir, ".mycli", "config.toml")));
});

test("config management exposes visual settings through the stable allowlist", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-config-visual-settings-"));
	const homeDir = join(root, "home");
	const workspaceRoot = join(root, "workspace");
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new ConfigManagementService({
		homeDir,
		workspaceRoot,
		env: {},
		workspaceTrust: "untrusted",
	});

	const updated = await service.set("tui.statusbar_mode", "compact", new AbortController().signal);
	assert.deepEqual({
		key: updated.key,
		changed: updated.changed,
		effectiveSource: updated.effectiveSource,
	}, {
		key: "tui.statusbar_mode",
		changed: true,
		effectiveSource: "user",
	});
	assert.deepEqual(
		(await service.get("tui.statusbar_mode", new AbortController().signal)).setting,
		{ key: "tui.statusbar_mode", value: "compact", source: "user", overridden: [] },
	);
	assert.deepEqual(parseToml(await readFile(join(homeDir, ".mycli", "config.toml"), "utf8")), {
		tui_statusbar_mode: "compact",
	});

	const removed = await service.unset("tui.statusbar_mode", new AbortController().signal);
	assert.equal(removed.effectiveSource, "default");
	assert.equal((await service.get("tui.statusbar_mode", new AbortController().signal)).setting.value, "full");
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
