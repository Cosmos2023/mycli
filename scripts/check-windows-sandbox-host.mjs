#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
	process.stderr.write("windows_sandbox_host_check_requires_windows\n");
	process.exitCode = 1;
} else {
	const helper = fileURLToPath(new URL(
		"../native/windows-sandbox-helper/build/Release/mycli-windows-sandbox.exe", import.meta.url,
	));
	const result = spawnSync(helper, ["--check-host"], {
		stdio: "inherit", windowsHide: true, timeout: 10_000,
	});
	if (result.error) {
		process.stderr.write(result.error.code === "ENOENT"
			? "windows_sandbox_helper_missing_build_first\n"
			: "windows_sandbox_host_check_failed\n");
	}
	process.exitCode = result.status ?? 1;
}
