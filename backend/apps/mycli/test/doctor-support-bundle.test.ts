import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConfigShowResponse } from "../src/management/config.ts";
import { reportFromChecks } from "../src/management/doctor/runner.ts";
import {
	buildDoctorSupportBundle,
	writeDoctorSupportBundle,
} from "../src/management/doctor/support-bundle.ts";
import type { SandboxStatusManagementResponse } from "../src/management/sandbox.ts";

test("support bundle structurally allowlists diagnostics and removes secrets and local paths", () => {
	const report = reportFromChecks([{
		name: "sessions_db",
		status: "failed",
		category: "storage",
		message: "failed at /Users/alice/private/session.db Authorization: Bearer support-secret",
		details: [
			"C:\\Users\\alice\\private\\sessions.db",
			"https://user:password@example.com/private?token=secret",
			"control\u0000text",
		],
		remediation: "Inspect /home/alice/.mycli/sessions.db",
		unexpected: { apiKey: "sk-nested-support-secret" },
	} as never, {
		name: "plugins",
		status: "warning",
		message: "one plugin is unavailable",
		category: "extension",
	}]);
	const bundle = buildDoctorSupportBundle({
		report,
		config: configSnapshot(),
		sandbox: sandboxResponse().readiness,
	});
	const encoded = JSON.stringify(bundle);

	assert.equal(bundle.schemaVersion, 1);
	assert.deepEqual(bundle.configuration, {
		workspaceTrust: "trusted",
		layers: [{ id: "user", scope: "user", enabled: true }],
	});
	assert.equal(bundle.readiness.sessions.status, "failed");
	assert.equal(bundle.readiness.extensions.status, "warning");
	assert.deepEqual(bundle.runtime.logReferences, [
		"logs/agent.log",
		"logs/errors.log",
		"logs/model-events.jsonl",
		"logs/model-raw/",
		"traces/",
	]);
	assert.doesNotMatch(encoded, /support-secret|Bearer|alice|password|unexpected|apiKey|sk-nested/u);
	assert.doesNotMatch(encoded, /\\u0000/u);
	assert.match(encoded, /\[PATH\]|\[REDACTED\]|\[URL\]/u);
});

test("support bundle redaction fuzz corpus contains free text across platforms", () => {
	const corpus = [
		"Authorization: Bearer fuzz-bearer-secret",
		"api_key=sk-fuzzsupportsecret",
		"https://user:fuzz-password@example.com/private?token=fuzz-url-secret",
		"/Users/fuzz-user/.mycli/config.toml",
		"/home/fuzz-user/.mycli/sessions.db",
		"/opt/private/fuzz-support.log",
		"~/private/fuzz-support.log",
		"C:\\Users\\fuzz-user\\AppData\\Local\\mycli\\config.toml",
		"\\\\fuzz-server\\private-share\\mycli.log",
		"control\u0000middle\u0085tail",
	];
	for (const [index, value] of corpus.entries()) {
		const bundle = buildDoctorSupportBundle({
			report: reportFromChecks([{
				name: `fuzz_${index}`,
				status: "failed",
				category: "storage",
				message: value,
				details: [value],
				remediation: value,
			}]),
			config: configSnapshot(),
			sandbox: sandboxResponse().readiness,
		});
		const encoded = JSON.stringify(bundle);
		assert.doesNotMatch(encoded, /fuzz-bearer-secret|sk-fuzzsupportsecret/u);
		assert.doesNotMatch(
			encoded,
			/fuzz-password|fuzz-url-secret|fuzz-user|fuzz-server|fuzz-support|private-share/u,
		);
		assert.doesNotMatch(encoded, /\\u0000|\u0085/u);
	}
});

test("support bundle writes one deterministic private atomic artifact", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-support-bundle-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const bundle = buildDoctorSupportBundle({
		report: reportFromChecks([{ name: "runtime", status: "ok", message: "ready" }]),
		config: configSnapshot(),
		sandbox: sandboxResponse().readiness,
	});
	const first = await writeDoctorSupportBundle(homeDir, bundle);
	const second = await writeDoctorSupportBundle(homeDir, bundle);
	const directory = join(homeDir, ".mycli", "support");
	const path = join(directory, "diagnostic-support.json");
	const content = await readFile(path, "utf8");

	assert.deepEqual(first, second);
	assert.equal(first.location, ".mycli/support/diagnostic-support.json");
	assert.equal(first.bytes, Buffer.byteLength(content, "utf8"));
	assert.match(first.sha256, /^[a-f0-9]{64}$/u);
	assert.deepEqual(JSON.parse(content), bundle);
	if (process.platform !== "win32") {
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	}
});

function configResponse(): ConfigShowResponse {
	return Object.freeze({
		version: 1,
		ok: true,
		action: "show",
		message: "effective configuration",
		workspaceTrust: "trusted",
		credentials: Object.freeze({ apiKey: "present" }),
		layers: Object.freeze([Object.freeze({ id: "user", scope: "user", enabled: true })]),
		settings: Object.freeze([]),
		diagnostics: Object.freeze([]),
	});
}

function configSnapshot(): Readonly<{
	readonly workspaceTrust: "trusted";
	readonly layers: ConfigShowResponse["layers"];
}> {
	const config = configResponse();
	return Object.freeze({ workspaceTrust: "trusted", layers: config.layers });
}

function sandboxResponse(): SandboxStatusManagementResponse {
	return Object.freeze({
		ok: true,
		action: "status",
		message: "mycli sandbox status",
		readiness: Object.freeze({
			state: "ready",
			code: "ready",
			platform: process.platform,
			isolation: "none",
			helperVersion: 1,
			helperCompatible: true,
			setupComplete: true,
			sandboxReady: true,
		}),
		exitCode: 0,
	});
}
