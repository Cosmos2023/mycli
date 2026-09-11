import { spawn } from "node:child_process";
import { join } from "node:path";
import { createProcessController } from "@mycli/tools";
import { PluginPackageError } from "./package-files.ts";

export async function runPackageGit(args: readonly string[], controlRoot: string, signal: AbortSignal): Promise<string> {
	signal.throwIfAborted();
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "SSH_AUTH_SOCK"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(controlRoot, "empty-config"), GIT_TEMPLATE_DIR: controlRoot });
	const child = spawn("git", ["-c", `core.hooksPath=${controlRoot}`, "-c", "protocol.allow=never",
		"-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", ...args], {
		cwd: controlRoot, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
	});
	const controller = child.pid ? createProcessController({
		pid: child.pid, get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
		kill: (selected) => child.kill(selected),
	}) : undefined;
	let failure = false;
	let cleanup: Promise<unknown> | undefined;
	const stop = (): void => { failure = true; cleanup ??= controller?.terminate(); };
	const timer = setTimeout(stop, 120_000);
	const chunks: Buffer[] = [];
	let bytes = 0;
	child.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > 1_048_576) stop();
		else chunks.push(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_048_576) stop(); });
	signal.addEventListener("abort", stop, { once: true });
	if (signal.aborted) stop();
	try {
		const code = await new Promise<number | null>((resolve) => {
			child.once("error", () => { failure = true; resolve(null); });
			child.once("close", resolve);
		});
		await cleanup;
		signal.throwIfAborted();
		if (failure || code !== 0) throw new PluginPackageError("plugin_git_failed");
		return Buffer.concat(chunks).toString("utf8").trim();
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		await controller?.terminate();
	}
}
