#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { APPLICATION_RELEASE_PACKAGE, RELEASE_ROOT } from "./release-config.mjs";
import { loadCompatibilityPolicy } from "./verify-release-compatibility.mjs";

export const EXTERNAL_BLOCK_EXIT_CODE = 77;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_COMMAND_OUTPUT_CHARS = 16_000_000;
const NETWORK_FAILURES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ERR_SOCKET_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"E500",
	"E502",
	"E503",
	"E504",
]);
const REGISTRY_STAGES = new Set([
	"predecessor_install",
	"candidate_install",
	"downgrade_install",
	"candidate_reinstall",
]);

class CommandFailure extends Error {
	constructor(stage, code) {
		const safeStage = diagnosticLabel(stage, "internal");
		const safeCode = diagnosticCode(code, "command_failed");
		super(`command_failed:${safeStage}:${safeCode}`);
		this.name = "CommandFailure";
		this.stage = safeStage;
		this.code = safeCode;
	}
}

export async function runReleaseCompatibilitySmoke(options) {
	const policy = await loadCompatibilityPolicy();
	const appManifest = JSON.parse(await readFile(
		join(RELEASE_ROOT, APPLICATION_RELEASE_PACKAGE.relativePath, "package.json"),
		"utf8",
	));
	const checks = [];
	const evidence = {
		schema_version: 1,
		status: "running",
		platform: process.platform,
		architecture: process.arch,
		node: process.versions.node,
		predecessor: {
			package: policy.application.predecessor.package,
			version: policy.application.predecessor.version,
		},
		candidate: {
			package: policy.application.package,
			version: appManifest.version,
		},
		checks,
	};
	const tempRoot = await mkdtemp(join(tmpdir(), "mycli-release-compatibility-"));

	try {
		const packDir = join(tempRoot, "packs");
		const prefix = join(tempRoot, "prefix");
		const home = join(tempRoot, "home");
		const cache = join(tempRoot, "npm-cache");
		await Promise.all([
			mkdir(packDir),
			mkdir(prefix),
			mkdir(join(home, ".config", "mycli"), { recursive: true }),
		]);
		const legacyPath = join(home, ".config", "mycli", "config.toml");
		const canonicalPath = join(home, ".mycli", "config.toml");
		await writeFile(legacyPath, "memory_enabled = true\n", "utf8");

		const candidatePack = JSON.parse(await run(
			"candidate_pack",
			"npm",
			[
				"pack",
				"--json",
				"--workspace",
				APPLICATION_RELEASE_PACKAGE.name,
				"--pack-destination",
				packDir,
				"--cache",
				cache,
				"--silent",
			],
			RELEASE_ROOT,
		));
		const candidateFile = candidatePack[0]?.filename;
		if (typeof candidateFile !== "string" || !candidateFile.endsWith(".tgz")) {
			throw new CommandFailure("candidate_pack", "invalid_inventory");
		}
		const candidateTarball = join(packDir, basename(candidateFile));
		record(checks, "candidate_packed");

		await installPackage({
			stage: "predecessor_install",
			prefix,
			cache,
			value: `${policy.application.predecessor.package}@${policy.application.predecessor.version}`,
		});
		const bin = installedBin(prefix);
		const runtimeEnv = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			NO_COLOR: "1",
			TERM: "dumb",
		};
		const predecessorVersion = (await run(
			"predecessor_version",
			bin,
			["--version"],
			prefix,
			runtimeEnv,
		)).trim();
		if (predecessorVersion !== policy.application.predecessor.version) {
			throw new CommandFailure("predecessor_version", "version_mismatch");
		}
		record(checks, "predecessor_started");

		await uninstallPackage({
			stage: "predecessor_uninstall",
			prefix,
			cache,
			value: policy.application.predecessor.package,
		});
		await installPackage({ stage: "candidate_install", prefix, cache, value: candidateTarball });
		const preview = JSON.parse(await run(
			"migration_preview",
			bin,
			["config", "migrate", "--dry-run", "--json"],
			prefix,
			runtimeEnv,
		));
		if (preview.needed !== true || typeof preview.expectedVersion !== "string") {
			throw new CommandFailure("migration_preview", "invalid_result");
		}
		const applied = JSON.parse(await run(
			"migration_apply",
			bin,
			["config", "migrate", "--apply", "--expected-version", preview.expectedVersion, "--json"],
			prefix,
			runtimeEnv,
		));
		if (applied.applied !== true || typeof applied.backupId !== "string"
			|| !existsSync(canonicalPath)) {
			throw new CommandFailure("migration_apply", "invalid_result");
		}
		const backupId = applied.backupId;
		record(checks, "upgrade_state_migrated");

		await uninstallPackage({
			stage: "candidate_uninstall",
			prefix,
			cache,
			value: policy.application.package,
		});
		await installPackage({
			stage: "downgrade_install",
			prefix,
			cache,
			value: `${policy.application.predecessor.package}@${policy.application.predecessor.version}`,
		});
		const doctor = JSON.parse(await run(
			"downgrade_doctor",
			bin,
			["doctor", "--json"],
			prefix,
			runtimeEnv,
			[0, 1],
		));
		if (!Array.isArray(doctor.checks)
			|| await readFile(legacyPath, "utf8") !== "memory_enabled = true\n") {
			throw new CommandFailure("downgrade_doctor", "state_unreadable");
		}
		record(checks, "downgrade_state_readable");

		await uninstallPackage({
			stage: "downgrade_uninstall",
			prefix,
			cache,
			value: policy.application.predecessor.package,
		});
		await installPackage({ stage: "candidate_reinstall", prefix, cache, value: candidateTarball });
		const rolledBack = JSON.parse(await run(
			"migration_rollback",
			bin,
			["config", "migrate", "--rollback", backupId, "--json"],
			prefix,
			runtimeEnv,
		));
		if (rolledBack.restored !== true || existsSync(canonicalPath)
			|| await readFile(legacyPath, "utf8") !== "memory_enabled = true\n") {
			throw new CommandFailure("migration_rollback", "invalid_result");
		}
		record(checks, "migration_rolled_back");

		evidence.status = "passed";
		await writeEvidence(options.evidencePath, evidence);
		process.stdout.write(`${JSON.stringify(evidence)}\n`);
		return 0;
	} catch (error) {
		const failure = normalizeFailure(error);
		if (isExternalBlocker(failure)) {
			evidence.status = "blocked_external";
			evidence.blocker = {
				kind: "registry_unavailable",
				stage: failure.stage,
				code: failure.code,
			};
			await writeEvidence(options.evidencePath, evidence);
			process.stdout.write(`${JSON.stringify(evidence)}\n`);
			return options.allowExternalBlocker ? 0 : EXTERNAL_BLOCK_EXIT_CODE;
		}
		evidence.status = "failed";
		evidence.failure = { stage: failure.stage, code: failure.code };
		await writeEvidence(options.evidencePath, evidence);
		process.stderr.write(
			`release_compatibility_smoke_failed: stage=${failure.stage} code=${failure.code}\n`,
		);
		return 1;
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

export function parseArguments(argv) {
	let allowExternalBlocker = false;
	let evidencePath;
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--allow-external-blocker") {
			allowExternalBlocker = true;
			continue;
		}
		if (value === "--evidence" && argv[index + 1]) {
			evidencePath = resolve(argv[index + 1]);
			index += 1;
			continue;
		}
		throw new Error("usage: smoke_release_compatibility.mjs [--allow-external-blocker] [--evidence path]");
	}
	return { allowExternalBlocker, evidencePath };
}

async function installPackage({ stage, prefix, cache, value }) {
	await run(stage, "npm", [
		"install",
		"--global",
		"--prefix",
		prefix,
		"--ignore-scripts",
		"--omit=optional",
		"--no-audit",
		"--no-fund",
		"--cache",
		cache,
		value,
	], RELEASE_ROOT);
}

async function uninstallPackage({ stage, prefix, cache, value }) {
	await run(stage, "npm", [
		"uninstall",
		"--global",
		"--prefix",
		prefix,
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--cache",
		cache,
		value,
	], RELEASE_ROOT);
}

function installedBin(prefix) {
	return process.platform === "win32" ? join(prefix, "mycli.cmd") : join(prefix, "bin", "mycli");
}

function run(stage, command, args, cwd, env = process.env, acceptedCodes = [0]) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) rejectPromise(error);
			else resolvePromise(value);
		};
		const append = (current, chunk) => {
			const next = current + chunk;
			if (next.length > MAX_COMMAND_OUTPUT_CHARS) {
				child.kill();
				settle(new CommandFailure(stage, "output_too_large"));
				return current;
			}
			return next;
		};
		const timeout = setTimeout(() => {
			child.kill();
			settle(new CommandFailure(stage, "ETIMEDOUT"));
		}, COMMAND_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
		child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
		child.once("error", (error) => {
			settle(new CommandFailure(stage, nodeErrorCode(error) ?? "spawn_failed"));
		});
		child.once("close", (code) => {
			if (acceptedCodes.includes(code)) {
				settle(undefined, stdout);
				return;
			}
			settle(new CommandFailure(stage, commandFailureCode(stderr)));
		});
	});
}

export function commandFailureCode(stderr) {
	for (const pattern of [
		/ripgrep_platform_stage_failed: kind=([A-Z0-9_]+)/u,
		/npm error code ([A-Z0-9_]+)/u,
		/\b(E(?:AI_AGAIN|CONNREFUSED|CONNRESET|HOSTUNREACH|NETUNREACH|NOTFOUND|TIMEDOUT|5\d\d))\b/u,
	]) {
		const match = pattern.exec(stderr);
		if (match?.[1]) return diagnosticCode(match[1], "command_failed");
	}
	return "command_failed";
}

function nodeErrorCode(error) {
	return typeof error === "object" && error !== null && "code" in error
		&& typeof error.code === "string"
		? diagnosticCode(error.code, "spawn_failed")
		: undefined;
}

function normalizeFailure(error) {
	if (error instanceof CommandFailure) return error;
	return new CommandFailure("internal", "unexpected_error");
}

export function isExternalBlockerCode(code) {
	return NETWORK_FAILURES.has(diagnosticCode(code, "unknown"));
}

export function isExternalBlocker(failure) {
	return failure !== null
		&& typeof failure === "object"
		&& REGISTRY_STAGES.has(diagnosticLabel(failure.stage, "internal"))
		&& isExternalBlockerCode(failure.code);
}

function diagnosticCode(value, fallback) {
	return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
		? value
		: fallback;
}

function diagnosticLabel(value, fallback) {
	return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
		? value
		: fallback;
}

function record(checks, id) {
	checks.push({ id, status: "passed" });
}

async function writeEvidence(path, value) {
	if (!path) return;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	process.exitCode = await runReleaseCompatibilitySmoke(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(() => {
		process.stderr.write(
			"release_compatibility_smoke_failed: stage=bootstrap code=unexpected_error\n",
		);
		process.exitCode = 1;
	});
}
