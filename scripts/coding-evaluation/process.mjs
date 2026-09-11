import { execFile, spawn } from "node:child_process";

export function runBoundedProcess({ argv, cwd, env, input = "", timeoutMs, signal }) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let reason;
		let killTimer;
		const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
		const kill = (force) => {
			if (!child.pid) return;
			if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => undefined);
			else { try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* The process group has already exited. */ } }
		};
		const stop = (code) => {
			if (reason) return;
			reason = code;
			kill(false);
			killTimer = setTimeout(() => kill(true), 250);
		};
		const onAbort = () => stop("interrupted");
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const capture = (stream) => (chunk) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > 4 * 1024 * 1024) { stop("output_limit"); return; }
			if (stream === "stdout") stdout += chunk;
			else stderr += chunk;
		};
		child.stdout.setEncoding("utf8").on("data", capture("stdout"));
		child.stderr.setEncoding("utf8").on("data", capture("stderr"));
		child.on("error", () => { reason = "spawn_failed"; });
		child.stdin.on("error", () => undefined);
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			kill(true);
			resolve({ code: reason ? 1 : code ?? 1, reason, stdout, stderr });
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		child.stdin.end(input);
	});
}
