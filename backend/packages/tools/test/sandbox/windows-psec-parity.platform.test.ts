import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createShellEnvironment, executionPolicy, inspectSandboxReadiness, prepareSandboxedProcess,
	type SandboxProfile } from "../../src/index.ts";

const runFile = promisify(execFile);
const readiness = process.platform === "win32" ? await inspectSandboxReadiness() : undefined;
const psec = { skip: process.platform !== "win32" || readiness?.isolation !== "windows_psec", timeout: 60_000 };

async function fixture(t: TestContext): Promise<{ root: string; workspace: string; outside: string; profile: SandboxProfile }> {
	assert.equal(readiness?.state, "ready", "PSEC setup must be ready before acceptance");
	const root = await mkdtemp(join(tmpdir(), "mycli-psec-parity-"));
	const workspace = join(root, "workspace");
	const outside = join(root, "outside");
	await mkdir(workspace);
	await mkdir(outside);
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	return { root, workspace, outside, profile: { ...executionPolicy("workspace", workspace), network: "disabled", workspaceRoot: workspace, cwd: workspace } };
}

function launch(code: string, profile: SandboxProfile, proxyPort?: number): ReturnType<typeof prepareSandboxedProcess> {
	return prepareSandboxedProcess([process.execPath, "--input-type=module", "-e", code], profile, {},
		proxyPort === undefined ? undefined : { port: proxyPort });
}

async function run(code: string, profile: SandboxProfile, proxyPort?: number): Promise<string> {
	return runPrepared(launch(code, profile, proxyPort), profile);
}

async function runPrepared(command: ReturnType<typeof launch>, profile: SandboxProfile): Promise<string> {
	const env = createShellEnvironment({ cwd: profile.cwd, sourceEnv: process.env, platform: "win32" }).env;
	const result = await runFile(command.executable, [...command.args], {
		cwd: profile.cwd, env: { ...env, ...command.env }, timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true,
	});
	return result.stdout.trim();
}

test("PSEC custom reads and readonly carveouts preserve denied and sibling boundaries", psec, async (t) => {
	const f = await fixture(t);
	const vendor = join(f.workspace, "vendor");
	await mkdir(vendor);
	const library = join(vendor, "library");
	const secret = join(f.outside, "secret");
	await writeFile(library, "library");
	await writeFile(secret, "private");
	const profile = { ...f.profile, readableRoots: [f.outside], readOnlyRoots: [vendor], deniedReadRoots: [secret] };
	assert.equal(await run(`import fs from 'node:fs';
console.log(fs.readFileSync(${JSON.stringify(library)},'utf8'));
for (const path of ${JSON.stringify([library, join(f.outside, "blocked")])}) {
  try { fs.writeFileSync(path,'bad'); process.exit(90); } catch(e) { if(e.code !== 'EACCES' && e.code !== 'EPERM') throw e; }
}
try { fs.readFileSync(${JSON.stringify(secret)}); process.exit(91); } catch(e) { if(e.code !== 'EACCES' && e.code !== 'EPERM') throw e; }
`, profile), "library");
	assert.equal(await readFile(library, "utf8"), "library");
	assert.equal(await run(`import fs from 'node:fs'; console.log(fs.readFileSync(${JSON.stringify(secret)},'utf8'));`, { ...f.profile, readableRoots: [f.outside] }), "private");
});

test("PSEC provides isolated writable temporary storage and cleans nonempty trees", psec, async (t) => {
	const f = await fixture(t);
	const output = await run(`import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const root=os.tmpdir();
for(const temp of new Set([root,process.env.TMPDIR])){fs.mkdirSync(path.join(temp,'nested'));fs.writeFileSync(path.join(temp,'nested','file'),'temporary');}
console.log(JSON.stringify({root, tmpdir:process.env.TMPDIR}));`, f.profile);
	const result = JSON.parse(output) as { root: string; tmpdir: string };
	assert.notEqual(result.root, tmpdir());
	await assert.rejects(readFile(join(result.root, "nested", "file")), { code: "ENOENT" });
	await assert.rejects(readFile(join(result.tmpdir, "nested", "file")), { code: "ENOENT" });
	for (const restriction of [{ deniedReadRoots: [dirname(result.tmpdir)] }, { readOnlyRoots: [dirname(result.tmpdir)] }]) {
		await assert.rejects(run("console.log('must-not-run')", { ...f.profile, ...restriction }), /temporary directory conflicts/u);
	}
	const child = start(t, `import fs from 'node:fs';import path from 'node:path';
fs.writeFileSync(path.join(process.env.TMPDIR,'recovery'),'temporary');
console.log(process.env.TMPDIR);process.stdin.resume();`, f.profile);
	const [temporary] = await once(child.lines, "line", { signal: t.signal });
	child.process.kill();
	await child.completed;
	assert.equal(await run("console.log('recovered')", f.profile), "recovered");
	await assert.rejects(readFile(join(String(temporary), "recovery")), { code: "ENOENT" });
});

test("PSEC linked policy roots pin every hop and retain target restrictions", psec, async (t) => {
	const f = await fixture(t);
	const alias = join(f.root, "linked-workspace");
	const hop = join(f.root, "linked-hop");
	const vendor = join(f.workspace, "vendor");
	const privateDirectory = join(f.workspace, "private");
	await mkdir(vendor);
	await mkdir(privateDirectory);
	await symlink(f.workspace, hop, "junction");
	await symlink(hop, alias, "junction");
	const library = join(vendor, "library");
	const secret = join(privateDirectory, "secret");
	await writeFile(library, "library");
	await writeFile(secret, "private");
	const profile = { ...f.profile, workspaceRoot: alias, cwd: alias, writableRoots: [alias],
		readOnlyRoots: [join(alias, "vendor")], deniedReadRoots: [join(alias, "private")], writableTemp: false };
	// Exercise the native boundary directly; the generic Node adapter normally
	// canonicalizes these fields before it calls the helper.
	const native = (code: string, roots: SandboxProfile = profile): ReturnType<typeof launch> => {
		const prepared = launch(code, f.profile);
		assert.equal(prepared.args[0], "--request-json");
		const payload: object = JSON.parse(prepared.args[1]!);
		return { ...prepared, args: ["--request-json", JSON.stringify({ ...payload,
			cwd: roots.cwd, workspace_roots: [roots.workspaceRoot], writable_roots: roots.writableRoots,
			readable_roots: roots.readableRoots ?? [], readonly_roots: roots.readOnlyRoots ?? [],
			denied_read_roots: roots.deniedReadRoots ?? [], writable_tmp: false })] };
	};
	const child = startPrepared(t, native(`import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(join(alias, "written"))},'allowed');
console.log(fs.readFileSync(${JSON.stringify(library)},'utf8'));
for(const path of ${JSON.stringify([library, join(alias, "vendor", "library"), secret, join(alias, "private", "secret"), join(f.outside, "blocked")])}) {
  try {fs.writeFileSync(path,'bad');process.exit(92);} catch(e) {if(e.code!=='EACCES'&&e.code!=='EPERM') throw e;}
}
for(const path of ${JSON.stringify([secret, join(alias, "private", "secret")])}) {
  try {fs.readFileSync(path);process.exit(93);} catch(e) {if(e.code!=='EACCES'&&e.code!=='EPERM') throw e;}
}
console.log('pinned');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`), f.profile);
	const lines: string[] = [];
	child.lines.on("line", (line) => { lines.push(line); });
	while (!lines.includes("pinned")) await once(child.lines, "line", { signal: t.signal });
	assert.deepEqual(lines, ["library", "pinned"]);
	for (const path of [alias, hop, f.workspace]) {
		await assert.rejects(rename(path, `${path}-moved`), (error: NodeJS.ErrnoException) =>
			["EACCES", "EPERM", "EBUSY"].includes(error.code ?? ""));
	}
	// The alias and direct policy identify the same roots for lease admission.
	assert.equal(await run("console.log('same-policy')", { ...profile, workspaceRoot: f.workspace,
		cwd: f.workspace, writableRoots: [f.workspace], readOnlyRoots: [vendor], deniedReadRoots: [privateDirectory] }), "same-policy");
	// PSEC enforces each command's policy in the kernel, so a divergent concurrent
	// policy is admitted instead of being rejected (Codex parity).
	assert.equal(await run("console.log('divergent-policy')", { ...f.profile,
		writableRoots: [vendor], deniedReadRoots: [privateDirectory] }), "divergent-policy");
	child.process.stdin.end();
	assert.deepEqual(await child.completed, [0, null]);
	assert.equal(await readFile(join(f.workspace, "written"), "utf8"), "allowed");
	assert.equal(await readFile(library, "utf8"), "library");
	assert.equal(await readFile(secret, "utf8"), "private");
	await rename(hop, `${hop}-moved`);
	await rename(`${hop}-moved`, hop);
	const cycle = join(f.root, "cycle");
	await symlink(cycle, cycle, "junction");
	await assert.rejects(runPrepared(native("console.log('must-not-run')", { ...f.profile, readableRoots: [cycle] }), f.profile), /psec_policy_reparse_limit/u);
	await rm(cycle);
	const absentDeny = join(f.workspace, "reserved-deny");
	const shared = { ...f.profile, deniedReadRoots: [absentDeny] };
	const hold = "console.log('ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
	const first = start(t, hold, shared);
	await once(first.lines, "line", { signal: t.signal });
	const second = start(t, hold, shared);
	await once(second.lines, "line", { signal: t.signal });
	first.process.stdin.end();
	assert.deepEqual(await first.completed, [0, null]);
	second.process.stdin.end();
	assert.deepEqual(await second.completed, [0, null]);
	await assert.rejects(readFile(absentDeny), { code: "ENOENT" });
	const abandoned = start(t, hold, shared);
	await once(abandoned.lines, "line", { signal: t.signal });
	abandoned.process.kill();
	await abandoned.completed;
	assert.equal(await run("console.log('recovered')", shared), "recovered");
	await assert.rejects(readFile(absentDeny), { code: "ENOENT" });
});

test("PSEC large permission payload stays off argv and is absent from the child environment", psec, async (t) => {
	const f = await fixture(t);
	const profile = { ...f.profile, readableRoots: Array.from({ length: 900 }, () => f.outside) };
	const code = "console.log(Object.keys(process.env).filter(k=>k.toUpperCase().startsWith('MYCLI_SANDBOX_REQUEST_')).length)";
	const prepared = launch(code, profile);
	assert.deepEqual(prepared.args, ["--request-env"]);
	assert.ok(Number(prepared.env?.MYCLI_SANDBOX_REQUEST_COUNT) > 8);
	assert.equal(await run(code, profile), "0");
	const env = createShellEnvironment({ cwd: profile.cwd, sourceEnv: process.env, platform: "win32" }).env;
	for (const invalid of [
		{ ...prepared.env, MYCLI_SANDBOX_REQUEST_COUNT: "327" },
		{ ...prepared.env, MYCLI_SANDBOX_REQUEST_0: "truncated" },
		{ MYCLI_SANDBOX_REQUEST_COUNT: "1", MYCLI_SANDBOX_REQUEST_0: "!!!!" },
	]) {
		await assert.rejects(runFile(prepared.executable, [...prepared.args], {
			cwd: profile.cwd, env: { ...env, ...invalid }, timeout: 5000, windowsHide: true,
		}), (error: unknown) => {
			assert.match(String(error), /carrier invalid/u);
			assert.equal((error as { stdout: string }).stdout, "");
			return true;
		});
	}
});

test("PSEC unrestricted filesystem retains offline networking and explicit carveouts", psec, async (t) => {
	const f = await fixture(t);
	const port = await server(t, "127.0.0.1");
	const target = join(f.outside, "written");
	const outsideAlias = join(f.root, "outside-alias");
	const readonlyAlias = join(f.root, "readonly-alias");
	const secret = join(f.outside, "secret");
	const secretAlias = join(f.outside, "secret-alias");
	await symlink(f.outside, outsideAlias, "junction");
	await symlink(f.workspace, readonlyAlias, "junction");
	await writeFile(secret, "private");
	await link(secret, secretAlias);
	const output = await run(`import fs from 'node:fs'; import net from 'node:net';
fs.writeFileSync(${JSON.stringify(target)},'allowed');
fs.writeFileSync(${JSON.stringify(join(outsideAlias, "via-junction"))},'allowed');
for (const path of ${JSON.stringify([join(readonlyAlias, "blocked"), join(outsideAlias, "secret"), secretAlias])}) {
  try { fs.writeFileSync(path,'bad'); process.exit(93); } catch(e) { if(e.code !== 'EACCES' && e.code !== 'EPERM') throw e; }
}
for (const path of ${JSON.stringify([join(outsideAlias, "secret"), secretAlias])}) {
  try { fs.readFileSync(path); process.exit(94); } catch(e) { if(e.code !== 'EACCES' && e.code !== 'EPERM') throw e; }
}
const connected=await new Promise(resolve=>{const s=net.connect(${port},'127.0.0.1');
s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.setTimeout(700,()=>{s.destroy();resolve(false)});});
console.log(connected);`, { ...f.profile, mode: "danger-full-access", filesystem: "unrestricted", readOnlyRoots: [f.workspace], deniedReadRoots: [secret] });
	assert.equal(output, "false");
	assert.equal(await readFile(target, "utf8"), "allowed");
	assert.equal(await readFile(join(f.outside, "via-junction"), "utf8"), "allowed");
	assert.equal(await readFile(secret, "utf8"), "private");
});

test("PSEC explicit local binding enables IPv4 and IPv6 loopback while strict proxy stays scoped", psec, async (t) => {
	const f = await fixture(t);
	const proxy = await server(t, "127.0.0.1");
	const foreign = await server(t, "127.0.0.1");
	const ipv6 = await server(t, "::1");
	const code = `import net from 'node:net'; const results=[];
for(const [port,host] of ${JSON.stringify([[proxy, "127.0.0.1"], [foreign, "127.0.0.1"], [ipv6, "::1"]])}) {
results.push(await new Promise(resolve=>{const s=net.connect(port,host);s.on('connect',()=>{s.destroy();resolve(true)});
s.on('error',()=>resolve(false));s.setTimeout(700,()=>{s.destroy();resolve(false)});}));}
console.log(JSON.stringify(results));`;
	const profile = { ...f.profile, network: "enabled" as const, networkDomains: ["example.com"] };
	assert.deepEqual(JSON.parse(await run(code, profile, proxy)), [true, false, false]);
	assert.deepEqual(JSON.parse(await run(code, { ...profile, allowLocalBinding: true }, proxy)), [true, true, true]);
	for (const host of ["127.0.0.1", "::1"]) {
		const bound = await run(`import net from 'node:net';
const s=net.createServer();s.listen(0,${JSON.stringify(host)},()=>{console.log(s.address().address);s.close();});`,
			{ ...profile, allowLocalBinding: true }, proxy);
		assert.equal(bound, host);
	}
});

test("PSEC compatible readers and independent policies overlap without widening writer authority", psec, async (t) => {
	const f = await fixture(t);
	const command = launch("console.log('ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));", f.profile);
	const child = spawn(command.executable, [...command.args], { cwd: f.workspace,
		env: { ...createShellEnvironment({ cwd: f.workspace, sourceEnv: process.env, platform: "win32" }).env, ...command.env },
		windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	const completed = once(child, "close");
	t.after(async () => { child.stdin.end(); await completed; });
	const [chunk] = await once(child.stdout, "data", { signal: t.signal });
	assert.match(String(chunk), /ready/u);
	const other = { ...f.profile, workspaceRoot: f.outside, cwd: f.outside, writableRoots: [f.outside], deniedReadRoots: [join(f.outside, "secret")] };
	assert.equal(await run("console.log('independent')", other), "independent");
	assert.equal(child.exitCode, null);
	const readonly = { ...f.profile, writableRoots: [], mode: "read-only" as const, filesystem: "read_only" as const };
	const target = join(f.workspace, "readable");
	await writeFile(target, "shared");
	assert.equal(await run(`import fs from 'node:fs';
console.log(fs.readFileSync(${JSON.stringify(target)},'utf8'));
for (const operation of [()=>fs.writeFileSync(${JSON.stringify(target)},'bad'),
  ()=>fs.linkSync(${JSON.stringify(target)},${JSON.stringify(join(f.workspace, "alias"))})]) {
  try { operation(); process.exit(92); } catch(e) { if(e.code !== 'EACCES' && e.code !== 'EPERM') throw e; }
}`, readonly), "shared");
	const nested = join(f.workspace, "nested");
	await mkdir(nested);
	// Divergent concurrent policies run side by side and keep their own scope.
	assert.equal(await run(`import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(join(nested, "written"))},'nested');console.log('nested');`,
		{ ...f.profile, writableRoots: [nested] }), "nested");
	assert.equal(await readFile(join(nested, "written"), "utf8"), "nested");
	assert.equal(await run("console.log('divergent-deny')", { ...readonly,
		deniedReadRoots: [target] }), "divergent-deny");
	child.stdin.end();
	assert.deepEqual(await completed, [0, null]);
	const reader = start(t, "console.log('ready');process.stdin.resume();", readonly);
	assert.deepEqual(await once(reader.lines, "line", { signal: t.signal }), ["ready"]);
	assert.equal(await run(`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(target)},'updated');console.log('written');`, f.profile), "written");
	assert.equal(reader.process.exitCode, null);
	assert.equal(await readFile(target, "utf8"), "updated");
	reader.process.kill();
	await reader.completed;
});

async function server(t: TestContext, host: string): Promise<number> {
	const sockets = new Set<Socket>();
	const listener: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") throw error; });
		socket.end("ok");
	});
	listener.listen(0, host);
	await once(listener, "listening");
	t.after(() => new Promise<void>((resolve, reject) => {
		for (const socket of sockets) socket.destroy();
		listener.close((error) => error ? reject(error) : resolve());
	}));
	const address = listener.address();
	assert.ok(address && typeof address !== "string");
	return address.port;
}

function start(t: TestContext, code: string, profile: SandboxProfile, proxyPort?: number): {
	readonly process: ChildProcessWithoutNullStreams;
	readonly completed: Promise<unknown[]>;
	readonly lines: Interface;
} {
	return startPrepared(t, launch(code, profile, proxyPort), profile);
}

function startPrepared(t: TestContext, command: ReturnType<typeof launch>, profile: SandboxProfile): {
	readonly process: ChildProcessWithoutNullStreams;
	readonly completed: Promise<unknown[]>;
	readonly lines: Interface;
} {
	const process = spawn(command.executable, [...command.args], { cwd: profile.cwd,
		env: { ...createShellEnvironment({ cwd: profile.cwd, sourceEnv: globalThis.process.env, platform: "win32" }).env, ...command.env },
		windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	const completed = once(process, "close");
	const lines = createInterface({ input: process.stdout });
	t.after(async () => { if (process.exitCode === null) process.kill(); await completed; lines.close(); });
	return { process, completed, lines };
}
