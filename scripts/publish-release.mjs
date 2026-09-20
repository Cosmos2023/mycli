#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	APPLICATION_RELEASE_PACKAGE,
	RELEASE_PACKAGES,
	RELEASE_ROOT,
	releasePackagePath,
} from "./release-config.mjs";
import { isReleaseVersion } from "./set-release-version.mjs";
import { verifyReleaseState } from "./verify-release.mjs";
import { assertWindowsPackageEvidence } from "./windows-sandbox-release-checks.mjs";

const NPM_REGISTRY = "https://registry.npmjs.org/";
const DIST_TAG_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

export function parsePublishArguments(argv) {
	let publish = false;
	let confirm;
	let provenance = false;
	let tag = "latest";
	let candidate;
	let windowsEvidence;
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--publish") {
			publish = true;
			continue;
		}
		if (value === "--dry-run") continue;
		if (value === "--provenance") {
			provenance = true;
			continue;
		}
		if (["--confirm", "--tag", "--candidate", "--windows-evidence"].includes(value)
			&& argv[index + 1] && !argv[index + 1].startsWith("--")) {
			if (value === "--confirm") confirm = argv[index + 1];
			if (value === "--tag") tag = argv[index + 1];
			if (value === "--candidate") candidate = resolve(argv[index + 1]);
			if (value === "--windows-evidence") windowsEvidence = resolve(argv[index + 1]);
			index += 1;
			continue;
		}
		throw new Error("usage: publish-release.mjs [--dry-run] [--publish --confirm X.Y.Z --candidate app.tgz --windows-evidence evidence.json] [--tag latest] [--provenance]");
	}
	if (!DIST_TAG_PATTERN.test(tag) || isReleaseVersion(tag)) {
		throw new Error(`release_dist_tag_invalid: ${tag}`);
	}
	if (publish && !isReleaseVersion(confirm)) {
		throw new Error("release_publish_confirmation_required");
	}
	if (!publish && confirm !== undefined) {
		throw new Error("release_publish_confirmation_without_publish");
	}
	if (publish && (!candidate || !windowsEvidence)) {
		throw new Error("release_windows_package_evidence_required");
	}
	return { publish, confirm, provenance, tag, ...(candidate ? { candidate } : {}),
		...(windowsEvidence ? { windowsEvidence } : {}) };
}

export function publishInvocation(releasePackage, options, root = RELEASE_ROOT) {
	const args = ["publish"];
	if (releasePackage.name === APPLICATION_RELEASE_PACKAGE.name && options.candidate) {
		args.push(options.candidate);
	} else if (releasePackage.workspace) args.push("--workspace", releasePackage.name);
	args.push(
		"--access",
		"public",
		"--tag",
		options.tag,
		"--registry",
		NPM_REGISTRY,
		"--cache",
		join(root, ".npm-cache", "release"),
	);
	if (!options.publish) args.push("--dry-run");
	if (options.provenance) args.push("--provenance");
	return {
		command: "npm",
		args,
		cwd: releasePackage.workspace ? root : releasePackagePath(releasePackage, root),
	};
}

export function isMissingRegistryVersion(stderr) {
	return /(?:\bE404\b|\b404 Not Found\b)/u.test(stderr);
}

export async function publishRelease(options, dependencies = {}) {
	const root = dependencies.root ?? RELEASE_ROOT;
	const run = dependencies.run ?? runCommand;
	const capture = dependencies.capture ?? captureCommand;
	const release = await verifyReleaseState({
		root,
		requireWindowsHelper: options.publish,
	});
	if (options.publish && options.confirm !== release.version) {
		throw new Error(
			`release_publish_confirmation_mismatch: expected ${release.version}, received ${options.confirm}`,
		);
	}
	if (options.publish) await verifyWindowsPackageEvidence(options, release.version, root);

	for (const releasePackage of RELEASE_PACKAGES) {
		if (options.publish && await registryVersionExists(
			releasePackage.name,
			release.version,
			capture,
			root,
		)) {
			process.stdout.write(`Skipping ${releasePackage.name}@${release.version}; already published.\n`);
			continue;
		}
		const invocation = publishInvocation(releasePackage, options, root);
		process.stdout.write(
			`${options.publish ? "Publishing" : "Dry-running"} ${releasePackage.name}@${release.version}.\n`,
		);
		await run(invocation.command, invocation.args, invocation.cwd);
	}
	return release;
}

export async function verifyWindowsPackageEvidence(options, version, root = RELEASE_ROOT) {
	if (!options.candidate || !options.windowsEvidence) {
		throw new Error("release_windows_package_evidence_required");
	}
	try {
		if ((await stat(options.windowsEvidence)).size > 16_384) throw new Error("oversized");
		const rawEvidence = await readFile(options.windowsEvidence, "utf8");
		const evidence = JSON.parse(rawEvidence.replace(/^\uFEFF/u, ""));
		const runFile = promisify(execFile);
		const { stdout } = await runFile("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 10_000 });
		assertWindowsPackageEvidence(evidence, {
			version, commit: stdout.trim(),
			candidateHash: createHash("sha256").update(await readFile(options.candidate)).digest("hex"),
			helperHash: createHash("sha256").update(await readFile(join(root,
				"backend/packages/tools/native/windows/mycli-windows-sandbox.exe"))).digest("hex"),
		});
	} catch {
		throw new Error("release_windows_package_evidence_invalid");
	}
}

export async function registryVersionExists(name, version, capture, root = RELEASE_ROOT) {
	const result = await capture("npm", [
		"view",
		`${name}@${version}`,
		"version",
		"--json",
		"--registry",
		NPM_REGISTRY,
		"--cache",
		join(root, ".npm-cache", "release"),
	], root);
	if (result.code === 0) return JSON.parse(result.stdout) === version;
	if (isMissingRegistryVersion(result.stderr)) return false;
	throw new Error(`release_registry_check_failed: ${name}@${version}: ${safeProcessDetail(result.stderr)}`);
}

function runCommand(command, args, cwd) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, { cwd, stdio: "inherit" });
		child.once("error", rejectPromise);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else rejectPromise(new Error(`release_command_failed: ${command} (${code ?? signal ?? "unknown"})`));
		});
	});
}

function captureCommand(command, args, cwd) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout = boundedAppend(stdout, chunk); });
		child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });
		child.once("error", rejectPromise);
		child.once("exit", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
	});
}

function boundedAppend(current, chunk) {
	return `${current}${chunk}`.slice(-16_384);
}

function safeProcessDetail(value) {
	return value
		.replace(/(?:npm_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})/gu, "[REDACTED]")
		.replace(/[\r\n\t ]+/gu, " ")
		.trim()
		.slice(-500) || "unknown npm error";
}

async function main() {
	const options = parsePublishArguments(process.argv.slice(2));
	const result = await publishRelease(options);
	process.stdout.write(
		`${options.publish ? "Published" : "Validated"} ${result.packageCount} packages for ${result.version}.\n`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "release_publish_failed"}\n`);
		process.exitCode = 1;
	});
}
