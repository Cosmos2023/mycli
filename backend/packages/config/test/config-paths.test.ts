import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	parseConfigProfileName,
	resolveConfigPath,
} from "../src/index.ts";

test("config paths resolve every scope and keep only the user path writable", () => {
	const homeDir = join("root", "home");
	const workspaceRoot = join("root", "workspace");
	const systemConfigPath = join("root", "machine", "config.toml");
	const profile = parseConfigProfileName("work");
	const scenarios = [
		["user", join(homeDir, ".mycli", "config.toml"), true],
		["project", join(workspaceRoot, ".mycli", "config.toml"), false],
		["profile", join(homeDir, ".mycli", "work.config.toml"), false],
		["system", systemConfigPath, false],
		["legacy_user", join(homeDir, ".config", "mycli", "config.toml"), false],
	] as const;

	for (const [scope, path, writable] of scenarios) {
		assert.deepEqual(resolveConfigPath({
			scope,
			homeDir,
			workspaceRoot,
			configProfile: profile,
			systemConfigPath,
		}), { scope, path, writable });
	}
});

test("config path helper validates profile requirements and runtime scope input", () => {
	const base = { homeDir: "/home/demo", workspaceRoot: "/workspace" };
	assert.throws(
		() => resolveConfigPath({ ...base, scope: "profile" }),
		/config_profile_required/u,
	);
	assert.throws(
		() => resolveConfigPath({ ...base, scope: "private" as "user" }),
		/config_path_scope_invalid/u,
	);
});
