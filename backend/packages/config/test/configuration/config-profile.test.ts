import assert from "node:assert/strict";
import { join, win32 } from "node:path";
import test from "node:test";
import {
	ConfigProfileNameError,
	parseConfigProfileName,
	resolveConfigProfilePath,
	resolveSystemConfigPath,
} from "../../src/index.ts";

test("config profile names accept only Codex-compatible plain names", () => {
	for (const value of ["work", "my-config", "team_2", "A1"]) {
		assert.equal(parseConfigProfileName(value), value);
	}
	for (const value of ["", ".", "../work", "work.toml", "a/b", "a\\b", "two words", "配置"]) {
		assert.throws(
			() => parseConfigProfileName(value),
			(error: unknown) => error instanceof ConfigProfileNameError
				&& error.message === "invalid_config_profile_name",
		);
	}
});

test("config profile paths stay under the mycli home", () => {
	const homeDir = join("home", "person");
	assert.equal(
		resolveConfigProfilePath(homeDir, parseConfigProfileName("work")),
		join(homeDir, ".mycli", "work.config.toml"),
	);
	assert.throws(
		() => resolveConfigProfilePath(homeDir, "../outside" as never),
		ConfigProfileNameError,
	);
});

test("system config paths follow Codex-style Unix and Windows locations", () => {
	assert.equal(resolveSystemConfigPath({ platform: "darwin" }), "/etc/mycli/config.toml");
	assert.equal(resolveSystemConfigPath({ platform: "linux" }), "/etc/mycli/config.toml");
	assert.equal(
		resolveSystemConfigPath({ platform: "win32", programDataDir: String.raw`D:\MachineData` }),
		win32.join(String.raw`D:\MachineData`, "mycli", "config.toml"),
	);
	assert.equal(
		resolveSystemConfigPath({ platform: "win32", programDataDir: "relative" }),
		win32.join(String.raw`C:\ProgramData`, "mycli", "config.toml"),
	);
	assert.equal(
		resolveSystemConfigPath({ platform: "win32", programDataDir: "   " }),
		win32.join(String.raw`C:\ProgramData`, "mycli", "config.toml"),
	);
	assert.equal(
		resolveSystemConfigPath({ platform: "win32" }),
		win32.join(String.raw`C:\ProgramData`, "mycli", "config.toml"),
	);
});
