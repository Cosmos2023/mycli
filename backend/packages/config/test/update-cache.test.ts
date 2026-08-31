import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	CachedUpdateError,
	CachedUpdateService,
	compareStableSemanticVersions,
	isStableSemanticVersion,
	updateInstallGuidance,
} from "../src/index.ts";

const PACKAGE_NAME = "@mycli/app";
const CURRENT_VERSION = "1.2.3";

test("stable semantic versions reject prerelease, build, and leading-zero forms", () => {
	for (const version of ["0.0.0", "1.2.3", "12345678901234567890.2.3"]) {
		assert.equal(isStableSemanticVersion(version), true);
	}
	for (const version of ["1.2", "01.2.3", "1.2.3-beta.1", "1.2.3+build", "v1.2.3"]) {
		assert.equal(isStableSemanticVersion(version), false);
	}
	assert.equal(compareStableSemanticVersions("2.0.0", "1.999.999"), 1);
	assert.equal(compareStableSemanticVersions("1.2.3", "1.2.3"), 0);
	assert.equal(compareStableSemanticVersions("1.2.2", "1.2.3"), -1);
});

test("cached update refresh writes a private valid record and advertises it on a later read", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const now = new Date("2026-08-30T00:00:00.000Z");
	const service = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		now: () => now,
		fetch: latestFetch("1.3.0"),
		env: { npm_config_user_agent: "npm/11.0.0 node/v24" },
	});

	const startup = await service.status(true);
	assert.equal(startup.availability, "unknown");
	assert.equal(startup.cacheState, "missing");
	assert.equal((await service.refreshIfNeeded(true)).outcome, "refreshed");
	const later = await service.status(true);
	assert.equal(later.availability, "available");
	assert.equal(later.cacheState, "fresh");
	assert.equal(later.latestVersion, "1.3.0");
	assert.equal(later.install.command, "npm install -g @mycli/app@latest");
	const cachePath = join(homeDir, ".mycli", "version.json");
	assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), {
		schemaVersion: 1,
		packageName: PACKAGE_NAME,
		latestVersion: "1.3.0",
		lastCheckedAt: now.toISOString(),
	});
	if (process.platform !== "win32") {
		assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
		assert.equal((await stat(join(homeDir, ".mycli"))).mode & 0o777, 0o700);
	}
	await service.close();
});

test("opt-out suppresses refresh and exact-version dismissal does not suppress a later version", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let requests = 0;
	let latest = "1.3.0";
	const service = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		fetch: (async () => {
			requests += 1;
			return latestResponse(latest);
		}) as typeof fetch,
	});

	assert.equal((await service.refreshIfNeeded(false)).outcome, "disabled");
	assert.equal(requests, 0);
	await service.refreshIfNeeded(true);
	assert.equal((await service.dismiss("1.3.0", true)).availability, "dismissed");
	await assert.rejects(
		() => service.dismiss("1.3.1", true),
		(error: unknown) => error instanceof CachedUpdateError
			&& error.code === "update_version_unavailable",
	);

	latest = "1.4.0";
	const future = new Date(Date.now() + 21 * 60 * 60 * 1_000);
	const refreshed = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		now: () => future,
		fetch: latestFetch(latest),
	});
	await refreshed.refreshIfNeeded(true);
	const status = await refreshed.status(true);
	assert.equal(status.latestVersion, "1.4.0");
	assert.equal(status.dismissedVersion, "1.3.0");
	assert.equal(status.availability, "available");
	await service.close();
	await refreshed.close();
});

test("explicit refresh bypasses a fresh cache without changing the startup preference", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let requests = 0;
	let latest = "1.3.0";
	let now = new Date("2026-08-30T00:00:00.000Z");
	const service = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		now: () => now,
		fetch: (async () => {
			requests += 1;
			return latestResponse(latest);
		}) as typeof fetch,
	});

	assert.equal((await service.refreshIfNeeded(true)).outcome, "refreshed");
	assert.equal((await service.refreshIfNeeded(true)).outcome, "not_needed");
	assert.equal(requests, 1);

	latest = "1.4.0";
	now = new Date("2026-08-30T00:01:00.000Z");
	const explicit = await service.refreshNow(false);
	assert.equal(explicit.outcome, "refreshed");
	assert.equal(explicit.status.checkOnStartup, false);
	assert.equal(explicit.status.availability, "disabled");
	assert.equal(explicit.status.latestVersion, "1.4.0");
	assert.equal(requests, 2);
	assert.equal((await service.status(true)).availability, "available");
	await service.close();
});

test("failed and malformed refreshes preserve an older valid cache", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	const oldRecord = {
		schemaVersion: 1,
		packageName: PACKAGE_NAME,
		latestVersion: "1.3.0",
		lastCheckedAt: "2026-08-01T00:00:00.000Z",
	};
	const path = join(directory, "version.json");
	await writeFile(path, `${JSON.stringify(oldRecord)}\n`, "utf8");
	const before = await readFile(path, "utf8");
	const service = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
		fetch: (async () => latestResponse("1.4.0-beta.1")) as typeof fetch,
	});

	const result = await service.refreshIfNeeded(true);
	assert.equal(result.outcome, "failed");
	assert.equal(result.status.latestVersion, "1.3.0");
	assert.equal(result.status.cacheState, "stale");
	assert.equal(await readFile(path, "utf8"), before);
	await service.close();
});

test("registry transport and protocol failures preserve an older valid cache", async (t) => {
	const failures: readonly [string, typeof fetch][] = [
		["offline", (async () => { throw new TypeError("offline"); }) as typeof fetch],
		["non-2xx", (async () => new Response("unavailable", { status: 503 })) as typeof fetch],
		["invalid-json", (async () => new Response("not-json", { status: 200 })) as typeof fetch],
		["oversized", (async () => new Response("x".repeat(65 * 1024), { status: 200 })) as typeof fetch],
	];
	for (const [name, fetch] of failures) {
		const homeDir = await temporaryDirectory(t);
		const directory = join(homeDir, ".mycli");
		await mkdir(directory, { recursive: true });
		const path = join(directory, "version.json");
		const previous = `${JSON.stringify({
			schemaVersion: 1,
			packageName: PACKAGE_NAME,
			latestVersion: "1.3.0",
			lastCheckedAt: "2026-08-01T00:00:00.000Z",
		})}\n`;
		await writeFile(path, previous, "utf8");
		const service = new CachedUpdateService({
			homeDir,
			packageName: PACKAGE_NAME,
			currentVersion: CURRENT_VERSION,
			now: () => new Date("2026-08-30T00:00:00.000Z"),
			fetch,
		});

		const result = await service.refreshNow(true);
		assert.equal(result.outcome, "failed", name);
		assert.equal(result.status.latestVersion, "1.3.0", name);
		assert.equal(await readFile(path, "utf8"), previous, name);
		await service.close();
	}
});

test("an oversized cache is read within bounds and atomically replaced", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	const path = join(directory, "version.json");
	await writeFile(path, "x".repeat(17 * 1024), "utf8");
	const service = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		fetch: latestFetch("1.4.0"),
	});

	assert.equal((await service.status(true)).cacheState, "invalid");
	assert.equal((await service.refreshNow(true)).outcome, "refreshed");
	const replacement = await readFile(path, "utf8");
	assert.ok(Buffer.byteLength(replacement, "utf8") < 16 * 1024);
	assert.equal(JSON.parse(replacement).latestVersion, "1.4.0");
	await service.close();
});

test("a newer concurrent refresh wins over an older delayed writer", async (t) => {
	const homeDir = await temporaryDirectory(t);
	let releaseOlder!: () => void;
	const olderFetch = new Promise<Response>((resolve) => {
		releaseOlder = () => resolve(latestResponse("1.3.0"));
	});
	const older = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
		fetch: (async () => olderFetch) as typeof fetch,
	});
	const newer = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		now: () => new Date("2026-08-30T00:01:00.000Z"),
		fetch: latestFetch("1.4.0"),
	});

	const pendingOlder = older.refreshIfNeeded(true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await newer.refreshIfNeeded(true)).outcome, "refreshed");
	releaseOlder();
	assert.equal((await pendingOlder).outcome, "refreshed");
	assert.equal((await newer.status(true)).latestVersion, "1.4.0");
	await older.close();
	await newer.close();
});

test("future timestamps are stale and closing aborts background refresh before resolving", async (t) => {
	const homeDir = await temporaryDirectory(t);
	const directory = join(homeDir, ".mycli");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "version.json"), JSON.stringify({
		schemaVersion: 1,
		packageName: PACKAGE_NAME,
		latestVersion: "1.3.0",
		lastCheckedAt: "2026-09-01T00:00:00.000Z",
	}), "utf8");
	let requestStarted = false;
	let requestAborted = false;
	let signalRequestStarted!: () => void;
	const started = new Promise<void>((resolve) => { signalRequestStarted = resolve; });
	const service = new CachedUpdateService({
		homeDir,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		now: () => new Date("2026-08-30T00:00:00.000Z"),
		fetch: (async (_input, init) => {
			requestStarted = true;
			signalRequestStarted();
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					requestAborted = true;
					reject(new DOMException("aborted", "AbortError"));
				}, { once: true });
			});
		}) as typeof fetch,
	});
	assert.equal((await service.status(true)).cacheState, "stale");
	service.startBackgroundRefresh(true);
	await started;
	assert.equal(requestStarted, true);
	const close = service.close();
	assert.equal(service.close(), close);
	await close;
	assert.equal(requestAborted, true);
});

test("timed out and unwritable refreshes remain non-fatal", async (t) => {
	const timeoutHome = await temporaryDirectory(t);
	const timedOut = new CachedUpdateService({
		homeDir: timeoutHome,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		requestTimeoutMs: 5,
		fetch: (async (_input, init) => await new Promise<Response>((_resolve, reject) => {
			const abort = (): void => reject(new DOMException("aborted", "AbortError"));
			if (init?.signal?.aborted) abort();
			else init?.signal?.addEventListener("abort", abort, { once: true });
		})) as typeof fetch,
	});
	const timeoutResult = await timedOut.refreshNow(true);
	assert.equal(timeoutResult.outcome, "failed");
	assert.equal(timeoutResult.status.cacheState, "missing");
	await timedOut.close();

	const unwritableHome = await temporaryDirectory(t);
	const cachePath = join(unwritableHome, ".mycli");
	await writeFile(cachePath, "path collision\n", "utf8");
	const unwritable = new CachedUpdateService({
		homeDir: unwritableHome,
		packageName: PACKAGE_NAME,
		currentVersion: CURRENT_VERSION,
		fetch: latestFetch("1.4.0"),
	});
	const unwritableResult = await unwritable.refreshNow(true);
	assert.equal(unwritableResult.outcome, "failed");
	assert.equal(unwritableResult.status.cacheState, "unreadable");
	assert.equal(await readFile(cachePath, "utf8"), "path collision\n");
	await unwritable.close();
});

test("installation guidance is evidence based with an explicit npm fallback", () => {
	assert.deepEqual(updateInstallGuidance(PACKAGE_NAME, {
		npm_config_user_agent: "pnpm/10.0.0 npm/? node/v24",
	}, ""), {
		method: "pnpm",
		command: "pnpm add -g @mycli/app@latest",
		fallback: false,
	});
	assert.deepEqual(updateInstallGuidance(PACKAGE_NAME, {}, "/opt/mycli/bin/mycli"), {
		method: "unknown",
		command: "npm install -g @mycli/app@latest",
		fallback: true,
	});
});

function latestFetch(version: string): typeof fetch {
	return (async () => latestResponse(version)) as typeof fetch;
}

function latestResponse(version: string): Response {
	return new Response(JSON.stringify({ version }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-update-cache-"));
	t.after(async () => rm(path, { recursive: true, force: true }));
	return path;
}
