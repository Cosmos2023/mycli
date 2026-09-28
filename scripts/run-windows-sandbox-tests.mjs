#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { release } from "node:os";
import { run } from "node:test";
import { execFileSync } from "node:child_process";
import { spec } from "node:test/reporters";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
	assertVendoredSandboxHelperIdentity,
} from "./windows-sandbox-release-checks.mjs";
import { runWindowsSandboxAcceptance } from "./windows-sandbox-acceptance.mjs";

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
	return sourceHash;
}

const evidence = await runWindowsSandboxAcceptance({
	platform: process.platform, osRelease: release(), nodeVersion: process.version, arch: process.arch,
	setupOptIn: process.env.MYCLI_WINDOWS_SANDBOX_SETUP_TESTS === "1",
	maintenanceOptIn: process.env.MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS === "1",
	verifyIdentity: verifyPromotedHelperIdentity,
	handshake: () => JSON.parse(execFileSync(HELPER_PATH, ["--handshake"], {
		encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
	})),
	runSuite: async (file) => {
		let summary;
		const tests = run({
			files: [fileURLToPath(new URL(`../backend/packages/tools/test/sandbox/${file}`, import.meta.url))],
			concurrency: 1,
			execArgv: ["--conditions=mycli-source", "--import", "tsx"],
		});
		tests.on("test:summary", (event) => {
			if (event.file === undefined) summary = event.counts;
		});
		const output = tests.compose(spec);
		output.pipe(process.stdout, { end: false });
		await finished(output);
		return summary;
	},
});
if (evidence.status !== "completed") {
	process.stderr.write(`${evidence.code}\n`);
	process.exitCode = 1;
}
const evidencePath = process.env.MYCLI_WINDOWS_SANDBOX_EVIDENCE;
if (evidencePath) {
	try {
		const content = `${JSON.stringify(evidence, null, 2)}\n`;
		if (Buffer.byteLength(content) > 16_384) throw new Error("oversized evidence");
		await mkdir(dirname(evidencePath), { recursive: true });
		await writeFile(evidencePath, content, "utf8");
	} catch {
		process.stderr.write("windows_sandbox_evidence_write_failed\n");
		process.exitCode = 1;
	}
}
