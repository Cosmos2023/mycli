#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { run } from "node:test";
import { execFileSync } from "node:child_process";
import { spec } from "node:test/reporters";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
	assertVendoredSandboxHelperIdentity,
	assertWindowsSuiteSummary,
	windowsSandboxSuites,
} from "./windows-sandbox-release-checks.mjs";

const HELPER_PATH = fileURLToPath(new URL(
	"../backend/packages/tools/native/windows/mycli-windows-sandbox.exe", import.meta.url,
));
const HELPER_MANIFEST_PATH = fileURLToPath(new URL(
	"../backend/packages/tools/native/windows/mycli-windows-sandbox.sha256", import.meta.url,
));
const VENDORED_HELPER_PATH = fileURLToPath(new URL(
	"../backend/apps/mycli/dist/node_modules/@mycli/tools/native/windows/mycli-windows-sandbox.exe",
	import.meta.url,
));

async function fileHash(path) {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch {
		return undefined;
	}
}

async function verifyPromotedHelperIdentity() {
	const sourceHash = await fileHash(HELPER_PATH);
	const manifest = await readFile(HELPER_MANIFEST_PATH, "utf8").catch(() => undefined);
	if (manifest === undefined || manifest.trim().toLowerCase() !== sourceHash) {
		throw new Error("windows_sandbox_helper_manifest_stale");
	}
	assertVendoredSandboxHelperIdentity(sourceHash, await fileHash(VENDORED_HELPER_PATH));
}

if (process.platform !== "win32"
	|| process.env.MYCLI_WINDOWS_SANDBOX_SETUP_TESTS !== "1"
	|| process.env.MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS !== "1") {
	process.stderr.write("windows_sandbox_gate_requires_windows_and_both_maintenance_opt_ins\n");
	process.exitCode = 1;
} else {
	try {
		await verifyPromotedHelperIdentity();
		const handshake = () => JSON.parse(execFileSync(fileURLToPath(new URL(
			"../backend/packages/tools/native/windows/mycli-windows-sandbox.exe", import.meta.url,
		)), ["--handshake"], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16_384 }));
		const before = handshake();
		for (const suite of windowsSandboxSuites(before)) {
			let summary;
			const tests = run({
				files: [fileURLToPath(new URL(`../backend/packages/tools/test/sandbox/${suite.file}`, import.meta.url))],
				concurrency: 1,
				execArgv: ["--conditions=mycli-source", "--import", "tsx"],
			});
			tests.on("test:summary", (event) => {
				if (event.file === undefined) summary = event.counts;
			});
			const output = tests.compose(spec);
			output.pipe(process.stdout, { end: false });
			await finished(output);
			assertWindowsSuiteSummary(summary, suite.count);
		}
		const after = handshake();
		windowsSandboxSuites(after);
		if (after.backend !== before.backend) throw new Error("windows_sandbox_backend_changed");
	} catch (error) {
		// Gate errors are bounded tokens; anything else collapses to the generic code
		// so a failure never leaks command output or private paths.
		const code = error instanceof Error && /^windows_sandbox_[a-z_]+$/u.test(error.message)
			? error.message : "windows_sandbox_suite_incomplete";
		process.stderr.write(`${code}\n`);
		process.exitCode = 1;
	}
}
