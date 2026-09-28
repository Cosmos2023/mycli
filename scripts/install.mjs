#!/usr/bin/env node

// Standalone by design: users can download this file without a checkout or dependencies.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

export const PACKAGE_NAME = "@cosmos2023/mycli";
export const MIN_NODE_VERSION = "22.19.0";
const REGISTRY = "https://registry.npmjs.org/";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const OUTPUT_LIMIT = 256 * 1024;

const HELP = `Install the published mycli CLI with visible progress. Requires Node.js >= ${MIN_NODE_VERSION} and npm.

Usage: node install.mjs [options]

  --version <version>  Install latest (default), next, or an exact release
  --prefix <path>      Install directory (default: ~/.local; Windows: %LOCALAPPDATA%/mycli)
  --cache <path>       Separate npm cache (default: ~/.cache/mycli/npm; Windows: %LOCALAPPDATA%/mycli/cache/npm)
  --verbose           Show npm and dependency build output
  --plain             Print progress as ordinary lines, without animation or color
  --dry-run           Show the installation plan without downloads or filesystem changes
  -h, --help          Show this help

The installer uses npm without sudo and does not change shell profiles or npm configuration.
Run it again to update. Configuration, credentials, and sessions are not part of the installation.
`;

/**
 * @typedef {{version: string, prefix?: string, cache?: string, verbose: boolean, plain: boolean,
 *   'dry-run': boolean, help: boolean}} InstallOptions
 */

/** @param {string[]} args @returns {InstallOptions} */
export function parseOptions(args) {
	const { values } = parseArgs({ args, options: {
		version: { type: "string", default: "latest" },
		prefix: { type: "string" },
		cache: { type: "string" },
		verbose: { type: "boolean", default: false },
		plain: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	} });
	if (values.help) return values;
	if (!["latest", "next"].includes(values.version) && !VERSION_PATTERN.test(values.version)) {
		throw new Error("--version must be latest, next, or an exact release such as 0.1.1.");
	}
	for (const name of ["prefix", "cache"]) {
		if (values[name] !== undefined && (!values[name].trim() || /[\x00-\x1f\x7f]/u.test(values[name]))) {
			throw new Error(`--${name} must be a non-empty directory path without control characters.`);
		}
	}
	return values;
}

/** @param {string} version @returns {void} */
export function checkNodeVersion(version) {
	const actual = version.replace(/^v/u, "").split(".").map(Number);
	const minimum = MIN_NODE_VERSION.split(".").map(Number);
	for (let index = 0; index < minimum.length; index += 1) {
		if (!Number.isInteger(actual[index]) || actual[index] < minimum[index]) break;
		if (actual[index] > minimum[index] || index === minimum.length - 1) return;
	}
	throw new Error(`Node.js ${version} is too old. Install Node.js >= ${MIN_NODE_VERSION} (Node 24 is supported), then retry.`);
}

/**
 * @param {InstallOptions} options
 * @returns {{prefix: string, cache: string, binDir: string, command: string, packageDir: string, entry: string, npmArgs: string[]}}
 */
export function createInstallPlan(options, {
	platform = process.platform, env = process.env, homeDir = homedir(), cwd = process.cwd(),
} = {}) {
	const paths = platform === "win32" ? path.win32 : path.posix;
	const localData = env.LOCALAPPDATA || paths.join(homeDir, "AppData", "Local");
	const prefix = paths.resolve(cwd, options.prefix ?? (platform === "win32"
		? paths.join(localData, "mycli") : paths.join(homeDir, ".local")));
	const cache = paths.resolve(cwd, options.cache ?? (platform === "win32"
		? paths.join(localData, "mycli", "cache", "npm")
		: paths.join(env.XDG_CACHE_HOME || paths.join(homeDir, ".cache"), "mycli", "npm")));
	const binDir = platform === "win32" ? prefix : paths.join(prefix, "bin");
	const packageDir = paths.join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "@cosmos2023", "mycli");
	return {
		prefix, cache, binDir, packageDir,
		command: paths.join(binDir, platform === "win32" ? "mycli.cmd" : "mycli"),
		entry: paths.join(packageDir, "dist", "cli.js"),
		npmArgs: ["install", "--global", `${PACKAGE_NAME}@${options.version}`, "--prefix", prefix,
			"--cache", cache, "--registry", REGISTRY, "--include=optional", "--bin-links=true",
			"--no-progress", "--no-fund", "--no-audit", "--foreground-scripts", "--loglevel=info", "--color=false"],
	};
}

async function findNpmCli() {
	// Run npm's JS entry with the checked Node, avoiding cmd.exe interpolation on Windows.
	const candidates = [process.env.npm_execpath];
	const directories = [path.dirname(process.execPath), ...(process.env.PATH ?? "").split(path.delimiter)];
	for (const directory of directories.filter(Boolean)) {
		candidates.push(path.join(directory, "npm"),
			path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
			path.resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
	}
	for (const candidate of new Set(candidates.filter(Boolean))) {
		const resolved = await realpath(candidate).catch(() => undefined);
		if (resolved && path.basename(resolved) === "npm-cli.js") return resolved;
	}
	throw new Error("npm was not found. Install Node.js with npm from https://nodejs.org/, then retry.");
}

async function checkCommandConflicts(plan) {
	const commands = process.platform === "win32"
		? ["mycli", "mycli.cmd", "mycli.ps1"].map((name) => path.join(plan.binDir, name)) : [plan.command];
	for (const command of commands) {
		const stat = await lstat(command).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (!stat) continue;
		if (stat.isSymbolicLink()) {
			const target = path.resolve(path.dirname(command), await readlink(command));
			if (target === plan.entry) continue;
		} else if (process.platform === "win32" && stat.isFile()) {
			const shim = (await readFile(command, "utf8")).replaceAll("\\", "/");
			if (shim.includes("node_modules/@cosmos2023/mycli/dist/cli.js")) continue;
		}
		throw new Error(`Another command already exists at ${command}. Move it aside or choose a different --prefix, then retry.`);
	}
}

/** @param {string} text @returns {string} */
export function cleanOutput(text) {
	return stripVTControlCharacters(text)
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "")
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gu, "$1[redacted]@")
		.replace(/\bnpm_[A-Za-z0-9]+\b/gu, "[redacted]")
		.replace(/((?:authorization|_authToken|password)\s*[:=]\s*)(?:Bearer\s+)?[^\s]+/giu, "$1[redacted]");
}

class Progress {
	constructor(options) {
		this.animated = !!process.stderr.isTTY && process.env.TERM !== "dumb" && !options.plain && !options.verbose;
		this.color = !!process.stderr.isTTY && process.env.TERM !== "dumb" && !("NO_COLOR" in process.env) && !options.plain;
	}
	async stage(number, label, action) {
		const started = Date.now();
		let frame = 0;
		const elapsed = () => Math.floor((Date.now() - started) / 1000);
		const draw = () => {
			const line = `[${number}/3] ${label} ${this.animated ? "|/-\\"[frame++ % 4] : "..."} ${elapsed()}s`;
			process.stderr.write(this.animated
				? `\r\x1b[2K${line.slice(0, Math.max(1, (process.stderr.columns || 80) - 1))}` : `${line}\n`);
		};
		draw();
		const timer = setInterval(draw, this.animated ? 150 : 10_000);
		timer.unref();
		let status = "OK";
		try {
			return await action();
		} catch (error) {
			status = error.name === "AbortError" ? "CANCELLED" : "FAILED";
			throw error;
		} finally {
			clearInterval(timer);
			const prefix = this.animated ? "\r\x1b[2K" : "";
			const result = this.color ? `\x1b[${status === "OK" ? "32" : "31"}m${status}\x1b[0m` : status;
			process.stderr.write(`${prefix}[${number}/3] ${label} ${result} (${elapsed()}s)\n`);
		}
	}
}

function terminateProcessTree(child, signal) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
		const killer = spawn(taskkill, ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
		killer.on("error", () => child.kill());
	} else {
		try { process.kill(-child.pid, signal); }
		catch (error) { if (error.code !== "ESRCH") child.kill(signal); }
	}
}

/**
 * Execute without a shell; bound captured output and clean up the entire build process group.
 * @param {string} command
 * @param {string[]} args
 * @param {{signal?: AbortSignal, onLine?: (line: string) => void, timeoutMs?: number}} options
 * @returns {Promise<string>}
 */
export function runCommand(command, args, { signal, onLine = () => {}, timeoutMs = 30_000 } = {}) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(signal.reason); return; }
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32", windowsHide: true });
		let output = "";
		let diagnostics = "";
		let failure;
		let killTimer;
		const readers = [child.stdout, child.stderr].map((input) => createInterface({ input }));
		readers[0].on("line", (line) => { output = (output + cleanOutput(line) + "\n").slice(-OUTPUT_LIMIT); });
		for (const reader of readers) reader.on("line", (line) => {
			const clean = cleanOutput(line);
			diagnostics = (diagnostics + clean + "\n").slice(-OUTPUT_LIMIT);
			onLine(clean);
		});
		const stop = (error) => {
			if (failure) return;
			failure = error;
			terminateProcessTree(child, "SIGTERM");
			killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 2_000);
			killTimer.unref();
		};
		const onAbort = () => stop(signal.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => stop(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s. Retry the installer; use --verbose to inspect npm output.`)), timeoutMs);
		timeout.unref();
		child.once("error", (error) => { failure ??= error; });
		child.once("close", (code, exitSignal) => {
			clearTimeout(timeout);
			clearTimeout(killTimer);
			// npm may exit before a build descendant that ignores SIGTERM and closes its pipes.
			if (failure && process.platform !== "win32") terminateProcessTree(child, "SIGKILL");
			signal?.removeEventListener("abort", onAbort);
			for (const reader of readers) reader.close();
			if (failure) reject(failure);
			else if (code !== 0) reject(Object.assign(new Error(`Command failed (${exitSignal ?? `exit ${code}`}).`), { output: diagnostics }));
			else resolve(output.trim());
		});
	});
}

async function commandOnPath() {
	const names = process.platform === "win32" ? ["mycli.exe", "mycli.cmd", "mycli.bat", "mycli"] : ["mycli"];
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		for (const name of names) {
			const candidate = path.resolve(directory, name);
			try {
				await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
				return { path: candidate, realPath: await realpath(candidate) };
			} catch (error) {
				if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
			}
		}
	}
	return undefined;
}

/** @param {string} value @param {NodeJS.Platform} platform @returns {string} */
export function shellQuote(value, platform = process.platform) {
	return `'${value.replaceAll("'", platform === "win32" ? "''" : "'\\''")}'`;
}

async function printSuccess(plan, version) {
	const active = await commandOnPath();
	const installed = await realpath(plan.command);
	const matches = active && (process.platform === "win32"
		? active.realPath.toLowerCase() === installed.toLowerCase() : active.realPath === installed);
	process.stdout.write(`\nInstalled mycli ${version}\nCommand: ${plan.command}\n`);
	if (!matches) {
		process.stdout.write(active ? `\nYour PATH currently selects ${active.path}.\n` : "\nThe install directory is not on your PATH yet.\n");
		process.stdout.write("Add it to this terminal's PATH:\n\n");
		process.stdout.write(process.platform === "win32"
			? `  $env:Path = ${shellQuote(plan.binDir + ";")} + $env:Path\n`
			: `  export PATH=${shellQuote(plan.binDir)}:"$PATH"\n`);
		process.stdout.write(process.platform === "win32"
			? "\nFor future terminals, add this directory to your user Path in Windows Environment Variables.\n"
			: "\nFor future terminals, add that export to your shell profile.\n");
	}
	process.stdout.write("\nNext:\n  mycli setup\n  mycli\n");
}

/** @param {string[]} args @returns {Promise<number>} */
export async function runInstaller(args) {
	let options;
	try { options = parseOptions(args); }
	catch (error) { process.stderr.write(`Error: ${cleanOutput(error.message)}\nRun with --help for usage.\n`); return 2; }
	if (options.help) { process.stdout.write(HELP); return 0; }
	const plan = createInstallPlan(options);
	if (options["dry-run"]) {
		process.stdout.write(`Dry run: no downloads or filesystem changes.\n${JSON.stringify(plan, null, 2)}\n`);
		return 0;
	}
	const controller = new AbortController();
	let interrupted;
	const onSignal = (signal) => {
		interrupted = signal;
		controller.abort(new DOMException("Installation cancelled. Run the installer again to retry.", "AbortError"));
	};
	const onInt = () => onSignal("SIGINT");
	const onTerm = () => onSignal("SIGTERM");
	process.on("SIGINT", onInt);
	process.on("SIGTERM", onTerm);
	const progress = new Progress(options);
	let installOutput = "";
	let logPath;
	try {
		process.stderr.write("mycli installer\n\n");
		const npmCli = await progress.stage(1, "Checking environment and install directory", async () => {
			checkNodeVersion(process.versions.node);
			const cli = await findNpmCli();
			await runCommand(process.execPath, [cli, "--version"], { signal: controller.signal });
			await checkCommandConflicts(plan);
			controller.signal.throwIfAborted();
			await mkdir(plan.prefix, { recursive: true });
			await mkdir(plan.cache, { recursive: true, mode: 0o700 });
			await access(plan.prefix, constants.W_OK);
			await access(plan.cache, constants.W_OK);
			return cli;
		});
		process.stderr.write(`  Install directory: ${plan.prefix}\n`);
		await progress.stage(2, "Downloading and installing", async () => {
			const candidateLog = path.join(plan.cache, `mycli-install-${Date.now()}-${process.pid}.log`);
			try {
				await runCommand(process.execPath, [npmCli, ...plan.npmArgs], {
					signal: controller.signal, timeoutMs: 20 * 60_000,
					onLine(line) {
						installOutput = (installOutput + line + "\n").slice(-OUTPUT_LIMIT);
						if (options.verbose) process.stderr.write(`${line}\n`);
					},
				});
			} finally {
				try {
					await writeFile(candidateLog, installOutput, { mode: 0o600, flag: "wx" });
					logPath = candidateLog;
				} catch { process.stderr.write("Could not save the installation log.\n"); }
			}
		});
		const version = await progress.stage(3, "Verifying installed command", async () => {
			controller.signal.throwIfAborted();
			const manifest = JSON.parse(await readFile(path.join(plan.packageDir, "package.json"), "utf8"));
			if (manifest.name !== PACKAGE_NAME || !VERSION_PATTERN.test(manifest.version)
				|| (VERSION_PATTERN.test(options.version) && manifest.version !== options.version)) {
				throw new Error("The installed package does not match the requested mycli release.");
			}
			await access(plan.command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
			await checkCommandConflicts(plan);
			const version = await runCommand(process.execPath, [plan.entry, "--version"], { signal: controller.signal });
			if (version !== manifest.version) throw new Error("The installed mycli command returned an unexpected version.");
			return version;
		});
		await printSuccess(plan, version);
		return 0;
	} catch (error) {
		process.stderr.write(`\n${interrupted ? "Cancelled" : "Error"}: ${cleanOutput(error.message)}\n`);
		const diagnostics = error.output || installOutput;
		if (diagnostics && !interrupted && (!options.verbose || error.output !== installOutput)) {
			process.stderr.write(`\nRecent command output:\n${diagnostics.trim().split("\n").slice(-18).join("\n")}\n`);
		}
		if (logPath) process.stderr.write(`\nInstallation log (recent output): ${logPath}\n`);
		if (["EACCES", "EPERM"].includes(error.code)) process.stderr.write("Choose a user-owned --prefix and --cache directory, then retry.\n");
		return interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
	} finally {
		process.removeListener("SIGINT", onInt);
		process.removeListener("SIGTERM", onTerm);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => undefined)) {
	process.exitCode = await runInstaller(process.argv.slice(2));
}
