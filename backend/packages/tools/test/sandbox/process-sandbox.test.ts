import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	executionPolicy,
	inspectSandboxReadiness,
	packagedWindowsSandboxHelper,
	prepareSandboxedProcess,
	ProcessSandboxError,
	type ProcessSandboxProbes,
} from "../../src/index.ts";

test("Windows sandbox helper resolves from the package native directory", () => {
	assert.equal(
		packagedWindowsSandboxHelper(),
		fileURLToPath(new URL("../../native/windows/mycli-windows-sandbox.exe", import.meta.url)),
	);
});

test("full access preserves the original process argv", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const argv = ["/bin/sh", "-c", "printf ok"] as const;

	const launch = prepareSandboxedProcess(argv, {
		...executionPolicy("full-access", workspace),
		workspaceRoot: workspace,
		cwd: workspace,
	}, probes("darwin", ["/usr/bin/sandbox-exec"]));

	assert.deepEqual(launch, {
		executable: "/bin/sh",
		args: ["-c", "printf ok"],
		isolation: "host_subprocess",
	});
});

test("domain-constrained launch without a proxy preserves filesystem access but stays offline", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const outside = await temporaryWorkspace(t);
	const policy = {
		...executionPolicy("full-access", workspace),
		networkDomains: ["api.example.com"],
	} as const;

	const mac = prepareSandboxedProcess(["/usr/bin/true"], {
		...policy,
		workspaceRoot: workspace,
		cwd: outside,
	}, probes("darwin", ["/usr/bin/sandbox-exec"]));
	const macProfile = mac.args[mac.args.indexOf("-p") + 1] ?? "";
	assert.match(macProfile, /allow file-write\*/u);
	assert.doesNotMatch(macProfile, /allow network-outbound/u);

	const linux = prepareSandboxedProcess(["/usr/bin/true"], {
		...policy,
		workspaceRoot: workspace,
		cwd: outside,
	}, probes("linux", ["/usr/bin/bwrap"]));
	assertArgumentWindow(linux.args, ["--bind", "/", "/"]);
	assert.equal(linux.args.includes("--unshare-net"), true);

	const helper = "C:\\mycli\\mycli-windows-sandbox.exe";
	const windows = prepareSandboxedProcess(["cmd.exe", "/c", "echo ok"], {
		...policy,
		workspaceRoot: workspace,
		cwd: outside,
	}, {
		...probes("win32", [helper]),
		windowsHelperPath: helper,
	});
	assert.equal(JSON.parse(windows.args[1] ?? "").network, "disabled");
});

test("macOS admits only the host-owned proxy port for a constrained policy", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const profile = {
		...executionPolicy("workspace", workspace), network: "enabled" as const,
		networkDomains: ["api.example.com"], workspaceRoot: workspace, cwd: workspace,
	};
	const launch = prepareSandboxedProcess(["/usr/bin/true"], profile,
		probes("darwin", ["/usr/bin/sandbox-exec"]), { port: 40_000 });
	const rules = launch.args[1]!;
	assert.match(rules, /\(allow network-outbound \(remote tcp "localhost:40000"\)\)/u);
	assert.doesNotMatch(rules, /\(allow network-outbound\)|allow network-inbound|allow network-bind/u);
	for (const invalid of [0, -1, 65_536, 1.5, NaN]) {
		assert.throws(() => prepareSandboxedProcess(["/usr/bin/true"], profile,
			probes("darwin", ["/usr/bin/sandbox-exec"]), { port: invalid }), ProcessSandboxError);
	}
	for (const platform of ["linux"] as const) {
		assert.throws(() => prepareSandboxedProcess(["command"], profile,
			probes(platform, []), { port: 40_000 }), { kind: "network_proxy_unavailable" });
	}
	for (const policy of [{ ...profile, network: "disabled" as const }, { ...profile, networkDomains: [] },
		{ ...profile, networkDomains: undefined }]) {
		assert.throws(() => prepareSandboxedProcess(["/usr/bin/true"], policy,
			probes("darwin", ["/usr/bin/sandbox-exec"]), { port: 40_000 }), ProcessSandboxError);
	}
});

test("macOS uses the fixed seatbelt executable and protects repository metadata", async (t) => {
	const workspace = await temporaryWorkspace(t);
	await Promise.all([".git", ".agents", ".codex"].map((name) => mkdir(join(workspace, name))));
	const canonicalWorkspace = await realpath(workspace);

	const launch = prepareSandboxedProcess(["/usr/bin/true"], {
		...executionPolicy("workspace", workspace),
		workspaceRoot: workspace,
		cwd: workspace,
	}, probes("darwin", ["/usr/bin/sandbox-exec"]));

	assert.equal(launch.executable, "/usr/bin/sandbox-exec");
	assert.equal(launch.isolation, "macos_seatbelt");
	assert.deepEqual(launch.args.slice(-2), ["--", "/usr/bin/true"]);
	assert.equal(launch.args.includes(`-DWRITABLE_ROOT_0=${canonicalWorkspace}`), true);
	for (const name of [".git", ".agents", ".codex"] as const) {
		assert.equal(launch.args.some((value) => value === `-DPROTECTED_ROOT_${name.slice(1).toUpperCase()}=${join(canonicalWorkspace, name)}`), true);
	}
	const profile = launch.args[launch.args.indexOf("-p") + 1];
	assert.match(profile ?? "", /deny file-write\*/u);
	assert.match(profile ?? "", /\(allow network-outbound\)/u);
});

test("Windows proxy authority is an explicit endpoint and absent endpoints stay offline", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const profile = { ...executionPolicy("workspace", workspace),
		networkDomains: ["api.example.com"], workspaceRoot: workspace, cwd: workspace };
	const helper = "C:\\mycli\\mycli-windows-sandbox.exe";
	const options = { ...probes("win32", [helper]), windowsHelperPath: helper };
	const proxied = prepareSandboxedProcess(["cmd.exe", "/c", "echo ok"], profile, options, { port: 40_000 });
	assert.equal(JSON.parse(proxied.args[1]!).network_proxy_port, 40_000);
	assert.equal(JSON.parse(proxied.args[1]!).network, "enabled");
	const offline = prepareSandboxedProcess(["cmd.exe", "/c", "echo ok"], profile, options);
	assert.equal(JSON.parse(offline.args[1]!).network, "disabled");
	assert.equal(Object.hasOwn(JSON.parse(offline.args[1]!), "network_proxy_port"), false);
	for (const port of [0, -1, 65_536, 1.5, NaN]) {
		assert.throws(() => prepareSandboxedProcess(["cmd.exe"], profile, options, { port }),
			{ kind: "network_proxy_unavailable" });
	}
});

test("macOS denies protected metadata paths before they exist", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const canonicalWorkspace = await realpath(workspace);

	const launch = prepareSandboxedProcess(["/usr/bin/true"], {
		...executionPolicy("workspace", workspace),
		workspaceRoot: workspace,
		cwd: workspace,
	}, probes("darwin", ["/usr/bin/sandbox-exec"]));

	for (const [name, key] of [
		[".git", "PROTECTED_ROOT_GIT"],
		[".agents", "PROTECTED_ROOT_AGENTS"],
		[".codex", "PROTECTED_ROOT_CODEX"],
	] as const) {
		assert.equal(launch.args.includes(`-D${key}=${join(canonicalWorkspace, name)}`), true);
	}
});

test("Linux Bubblewrap fixes the base argv, writable bind, metadata protection, and network", async (t) => {
	const workspace = await temporaryWorkspace(t);
	await Promise.all([".git", ".agents", ".codex"].map((name) => mkdir(join(workspace, name))));
	const canonicalWorkspace = await realpath(workspace);

	const launch = prepareSandboxedProcess(["/bin/sh", "-c", "printf ok"], {
		...executionPolicy("workspace", workspace),
		workspaceRoot: workspace,
		cwd: workspace,
	}, probes("linux", ["/usr/bin/bwrap"]));

	assert.equal(launch.executable, "/usr/bin/bwrap");
	assert.equal(launch.isolation, "linux_bubblewrap");
	assert.deepEqual(launch.args.slice(0, 5), [
		"--new-session",
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
	]);
	assertArgumentWindow(launch.args, ["--bind", canonicalWorkspace, canonicalWorkspace]);
	for (const name of [".git", ".agents", ".codex"] as const) {
		const path = join(canonicalWorkspace, name);
		assertArgumentWindow(launch.args, ["--ro-bind", path, path]);
	}
	assert.equal(launch.args.includes("--unshare-net"), false);
	assertArgumentWindow(launch.args, ["--chdir", canonicalWorkspace, "--"]);
	assert.deepEqual(launch.args.slice(-3), ["/bin/sh", "-c", "printf ok"]);
});

test("read-only Linux has no writable bind", async (t) => {
	const workspace = await temporaryWorkspace(t);

	const launch = prepareSandboxedProcess(["/usr/bin/true"], {
		...executionPolicy("read-only", workspace),
		workspaceRoot: workspace,
		cwd: workspace,
	}, probes("linux", ["/bin/bwrap"]));

	assert.equal(launch.executable, "/bin/bwrap");
	assert.equal(launch.args.includes("--bind"), false);
	assert.equal(launch.args.includes("--unshare-net"), true);
});

test("Windows uses protocol version 1 with the injected restricted-token helper", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const canonicalWorkspace = await realpath(workspace);
	const helper = "C:\\mycli\\mycli-windows-sandbox.exe";

	const launch = prepareSandboxedProcess(["cmd.exe", "/c", "echo ok"], {
		...executionPolicy("workspace", workspace),
		workspaceRoot: workspace,
		cwd: workspace,
	}, {
		...probes("win32", [helper]),
		windowsHelperPath: helper,
	});

	assert.equal(launch.executable, helper);
	assert.equal(launch.isolation, "windows_restricted_token");
	assert.equal(launch.args[0], "--request-json");
	assert.deepEqual(JSON.parse(launch.args[1] ?? ""), {
		protocol_version: 1,
		command: { argv: ["cmd.exe", "/c", "echo ok"] },
		cwd: canonicalWorkspace,
		workspace_roots: [canonicalWorkspace],
		writable_roots: [canonicalWorkspace],
		denied_read_roots: [],
		denied_read_globs: [],
		filesystem: "workspace_write",
		network: "enabled",
		mode: "workspace-write",
	});
});

test("restricted profiles fail closed when the platform wrapper is unavailable", async (t) => {
	const workspace = await temporaryWorkspace(t);

	for (const platform of ["darwin", "linux", "win32"] as const) {
		assert.throws(() => prepareSandboxedProcess(["command"], {
			...executionPolicy("workspace", workspace),
			workspaceRoot: workspace,
			cwd: workspace,
		}, probes(platform, [])), (error: unknown) => {
			assert.equal(error instanceof ProcessSandboxError, true);
			assert.equal((error as ProcessSandboxError).kind, "sandbox_unavailable");
			return true;
		});
	}
});

test("sandbox readiness reports macOS missing Linux and unsupported platforms", async () => {
	assert.deepEqual(await inspectSandboxReadiness(probes("darwin", ["/usr/bin/sandbox-exec"])), {
		state: "ready",
		code: "ready",
		platform: "darwin",
		isolation: "macos_seatbelt",
	});
	assert.deepEqual(await inspectSandboxReadiness(probes("linux", [])), {
		state: "unavailable",
		code: "helper_missing",
		platform: "linux",
		isolation: "linux_bubblewrap",
	});
	assert.deepEqual(await inspectSandboxReadiness({ platform: "aix" }), {
		state: "unavailable",
		code: "unsupported_platform",
		platform: "aix",
		isolation: "none",
	});
});

test("Linux sandbox readiness probes namespace enforcement instead of executable presence", async () => {
	const calls: string[] = [];
	const ready = await inspectSandboxReadiness({
		platform: "linux",
		isExecutable: (path) => path === "/usr/bin/bwrap",
		linuxBubblewrapProbe: async (path) => {
			calls.push(path);
			return true;
		},
	});
	assert.deepEqual(calls, ["/usr/bin/bwrap"]);
	assert.deepEqual(ready, {
		state: "ready",
		code: "ready",
		platform: "linux",
		isolation: "linux_bubblewrap",
	});

	for (const linuxBubblewrapProbe of [
		async () => false,
		async () => { throw new Error("bwrap: loopback setup denied"); },
	]) {
		const unavailable = await inspectSandboxReadiness({
			platform: "linux",
			isExecutable: () => true,
			linuxBubblewrapProbe,
		});
		assert.deepEqual(unavailable, {
			state: "unavailable",
			code: "enforcement_unavailable",
			platform: "linux",
			isolation: "linux_bubblewrap",
		});
	}
});

test("Windows sandbox readiness validates bounded handshake states", async () => {
	const helper = "C:\\mycli\\mycli-windows-sandbox.exe";
	const inspect = (handshake: {
		readonly name: string;
		readonly protocolVersion: number;
		readonly setupComplete: boolean;
		readonly sandboxReady: boolean;
	}) => inspectSandboxReadiness({
		platform: "win32",
		windowsHelperPath: helper,
		isExecutable: (path) => path === helper,
		windowsHandshake: async () => handshake,
	});

	assert.equal((await inspect({
		name: "mycli-windows-sandbox",
		protocolVersion: 1,
		setupComplete: false,
		sandboxReady: false,
	})).state, "setup_required");
	assert.equal((await inspect({
		name: "mycli-windows-sandbox",
		protocolVersion: 1,
		setupComplete: true,
		sandboxReady: false,
	})).code, "enforcement_unavailable");
	assert.equal((await inspect({
		name: "mycli-windows-sandbox",
		protocolVersion: 1,
		setupComplete: true,
		sandboxReady: true,
	})).state, "ready");
	assert.equal((await inspect({
		name: "other-helper",
		protocolVersion: 1,
		setupComplete: true,
		sandboxReady: true,
	})).code, "handshake_failed");
	assert.equal((await inspect({
		name: "mycli-windows-sandbox",
		protocolVersion: 1,
		setupComplete: false,
		sandboxReady: true,
	})).code, "handshake_failed");
});

test("Windows sandbox readiness fails closed for a missing or failed helper", async () => {
	const helper = "C:\\mycli\\mycli-windows-sandbox.exe";
	assert.equal((await inspectSandboxReadiness({
		platform: "win32",
		windowsHelperPath: helper,
		isExecutable: () => false,
	})).code, "helper_missing");
	assert.equal((await inspectSandboxReadiness({
		platform: "win32",
		windowsHelperPath: helper,
		isExecutable: () => true,
		windowsHandshake: async () => { throw new Error("private helper output"); },
	})).code, "handshake_failed");
});

test("Linux fails closed when protected metadata is a writable symlink", async (t) => {
	const workspace = await temporaryWorkspace(t);
	const outside = await temporaryWorkspace(t);
	await symlink(outside, join(workspace, ".git"));

	assert.throws(() => prepareSandboxedProcess(["/usr/bin/true"], {
		...executionPolicy("workspace", workspace),
		workspaceRoot: workspace,
		cwd: workspace,
	}, probes("linux", ["/usr/bin/bwrap"])), (error: unknown) => {
		assert.equal(error instanceof ProcessSandboxError, true);
		assert.equal((error as ProcessSandboxError).kind, "sandbox_unavailable");
		return true;
	});
});

function probes(
	platform: NodeJS.Platform,
	executables: readonly string[],
): ProcessSandboxProbes {
	return {
		platform,
		isExecutable: (path) => executables.includes(path),
	};
}

function assertArgumentWindow(args: readonly string[], expected: readonly string[]): void {
	assert.notEqual(args.findIndex((_, index) => (
		expected.every((item, offset) => args[index + offset] === item)
	)), -1, `missing argv window: ${expected.join(" ")}`);
}

async function temporaryWorkspace(t: test.TestContext): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "mycli-process-sandbox-"));
	t.after(() => import("node:fs/promises").then(({ rm }) => (
		rm(workspace, { recursive: true, force: true })
	)));
	return workspace;
}
