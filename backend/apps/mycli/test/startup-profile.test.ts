import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	StartupProfiler,
	startupProfileEnabled,
	writeStartupProfile,
} from "../src/node-runtime/startup-profile.ts";

test("startup profiling is enabled only by the exact opt-in value", () => {
	assert.equal(startupProfileEnabled({}), false);
	assert.equal(startupProfileEnabled({ MYCLI_STARTUP_PROFILE: "true" }), false);
	assert.equal(startupProfileEnabled({ MYCLI_STARTUP_PROFILE: "1" }), true);
});

test("startup profiler emits only bounded stage timing snapshots", () => {
	let now = 100;
	const profiler = new StartupProfiler({
		enabled: true,
		scope: "backend",
		origin: 80,
		clock: () => now,
	});
	profiler.mark("runtime_entered");
	now = 140;
	profiler.mark("config_ready");
	now = 155;
	profiler.mark("integration_discovery_started");
	assert.deepEqual(profiler.snapshot(), {
		scope: "backend",
		marks: [
			{ stage: "runtime_entered", elapsedMs: 20 },
			{ stage: "config_ready", elapsedMs: 60 },
			{ stage: "integration_discovery_started", elapsedMs: 75 },
		],
	});
	assert.equal(new StartupProfiler({ enabled: false, scope: "cli" }).snapshot(), undefined);
});

test("startup profile writer atomically replaces one private redacted report", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-startup-profile-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	const first = {
		scope: "cli" as const,
		marks: [{ stage: "module_ready" as const, elapsedMs: 42 }],
	};
	const second = {
		scope: "backend" as const,
		marks: [{ stage: "gateway_ready" as const, elapsedMs: 77 }],
	};
	await writeStartupProfile({ homeDir, profiles: [first] });
	await writeStartupProfile({ homeDir, profiles: [second] });

	const directory = join(homeDir, ".mycli", "logs");
	const path = join(directory, "startup-profile.json");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
		schema_version: 1,
		profiles: [second],
	});
	if (process.platform !== "win32") {
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	}
});

test("startup profile writer creates nothing for a disabled empty snapshot", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-startup-profile-disabled-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));

	await writeStartupProfile({ homeDir, profiles: [] });

	await assert.rejects(stat(join(homeDir, ".mycli", "logs")), { code: "ENOENT" });
});
