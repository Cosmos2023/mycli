import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	initializeRipgrepEnvironment,
	prependRipgrepToPath,
	RIPGREP_TARGETS,
	resolveRipgrep,
	ripgrepOutputPath,
	ripgrepPlatformKey,
} from "../../src/index.ts";

test("ripgrep target normalization matches the Python runtime layout", () => {
	assert.equal(ripgrepPlatformKey("darwin", "arm64"), "macos-aarch64");
	assert.equal(ripgrepPlatformKey("macos", "aarch64"), "macos-aarch64");
	assert.equal(ripgrepPlatformKey("linux", "amd64"), "linux-x86_64");
	assert.equal(ripgrepPlatformKey("win32", "x64"), "windows-x86_64");
	assert.throws(() => ripgrepPlatformKey("freebsd", "x64"), /unsupported ripgrep platform/u);
	assert.throws(() => ripgrepPlatformKey("linux", "riscv64"), /unsupported ripgrep architecture/u);
	assert.equal(RIPGREP_TARGETS["macos-aarch64"].npmPackage, "@cosmos2023/ripgrep-darwin-arm64");
	assert.equal(RIPGREP_TARGETS["linux-x86_64"].npmPackage, "@cosmos2023/ripgrep-linux-x64");
	assert.equal(RIPGREP_TARGETS["windows-aarch64"].npmPackage, "@cosmos2023/ripgrep-win32-arm64");
});

test("platform package ripgrep wins over legacy package, user, and system binaries", async (t) => {
	const root = await temporaryDirectory(t);
	const packageRoot = join(root, "package");
	const platformPackageRoot = join(root, "platform-package");
	const homeDir = join(root, "home");
	const systemDir = join(root, "system");
	const target = ripgrepPlatformKey();
	const platformBinary = ripgrepOutputPath(join(platformPackageRoot, "vendor"), target);
	const packageBinary = ripgrepOutputPath(join(packageRoot, "native", "ripgrep"), target);
	const userBinary = ripgrepOutputPath(join(homeDir, ".mycli", "vendor", "ripgrep"), target);
	await Promise.all([
		writeExecutable(platformBinary),
		writeExecutable(packageBinary),
		writeExecutable(userBinary),
		writeExecutable(join(systemDir, "rg")),
	]);

	assert.equal(resolveRipgrep({
		packageRoot,
		platformPackageRoot,
		homeDir,
		pathValue: systemDir,
	}), platformBinary);
});

test("legacy package ripgrep remains ahead of user and system fallbacks", async (t) => {
	const root = await temporaryDirectory(t);
	const packageRoot = join(root, "package");
	const homeDir = join(root, "home");
	const target = ripgrepPlatformKey();
	const packageBinary = ripgrepOutputPath(join(packageRoot, "native", "ripgrep"), target);
	const userBinary = ripgrepOutputPath(join(homeDir, ".mycli", "vendor", "ripgrep"), target);
	await Promise.all([writeExecutable(packageBinary), writeExecutable(userBinary)]);

	assert.equal(resolveRipgrep({
		packageRoot,
		platformPackageRoot: null,
		homeDir,
		pathValue: "",
	}), packageBinary);
});

test("user-vendored ripgrep is prepended once and exported as its directory", async (t) => {
	const root = await temporaryDirectory(t);
	const packageRoot = join(root, "package");
	const homeDir = join(root, "home");
	const target = ripgrepPlatformKey();
	const userBinary = ripgrepOutputPath(join(homeDir, ".mycli", "vendor", "ripgrep"), target);
	await writeExecutable(userBinary);
	const directory = dirname(userBinary);

	const result = prependRipgrepToPath({
		packageRoot,
		platformPackageRoot: null,
		homeDir,
		pathValue: ["/usr/bin", directory, directory].join(delimiter),
	});

	assert.equal(result.executable, userBinary);
	assert.equal(result.directory, directory);
	assert.deepEqual(result.path.split(delimiter), [directory, "/usr/bin"]);
});

test("existing PATH ripgrep remains available when no vendored binary exists", async (t) => {
	const root = await temporaryDirectory(t);
	const systemDir = join(root, "system");
	const systemBinary = join(systemDir, process.platform === "win32" ? "rg.exe" : "rg");
	await writeExecutable(systemBinary);

	const result = prependRipgrepToPath({
		packageRoot: join(root, "package"),
		platformPackageRoot: null,
		homeDir: join(root, "home"),
		pathValue: ["/usr/bin", systemDir].join(delimiter),
	});

	assert.equal(result.executable, systemBinary);
	assert.equal(result.path, [systemDir, "/usr/bin"].join(delimiter));
});

test("process startup injects the packaged binary and is idempotent", async (t) => {
	const root = await temporaryDirectory(t);
	const packageRoot = join(root, "package");
	const binary = ripgrepOutputPath(
		join(packageRoot, "native", "ripgrep"),
		ripgrepPlatformKey(),
	);
	await writeExecutable(binary);
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

	const first = initializeRipgrepEnvironment({
		env,
		packageRoot,
		platformPackageRoot: null,
		homeDir: join(root, "home"),
	});
	const second = initializeRipgrepEnvironment({
		env,
		packageRoot,
		platformPackageRoot: null,
		homeDir: join(root, "home"),
	});

	assert.equal(first.executable, binary);
	assert.equal(second.executable, binary);
	assert.deepEqual(second.path.split(delimiter), [dirname(binary), "/usr/bin"]);
	assert.equal(env.PATH, second.path);
	assert.equal(env.MYCLI_RIPGREP_PATH_DIR, dirname(binary));
});

test("explicit empty PATH stays isolated when no vendored binary exists", async (t) => {
	const root = await temporaryDirectory(t);
	const env: NodeJS.ProcessEnv = {
		PATH: "",
		MYCLI_RIPGREP_PATH_DIR: "/stale/ripgrep",
	};

	const result = initializeRipgrepEnvironment({
		env,
		packageRoot: join(root, "package"),
		platformPackageRoot: null,
		homeDir: join(root, "home"),
	});

	assert.equal(result.executable, undefined);
	assert.equal(env.PATH, "");
	assert.equal(env.MYCLI_RIPGREP_PATH_DIR, undefined);
});

test("Windows lookup uses rg.exe and a semicolon-delimited PATH", async (t) => {
	const root = await temporaryDirectory(t);
	const homeDir = join(root, "home");
	const target = ripgrepPlatformKey("win32", "x64");
	const binary = ripgrepOutputPath(join(homeDir, ".mycli", "vendor", "ripgrep"), target);
	await writeExecutable(binary);

	const result = prependRipgrepToPath({
		platform: "win32",
		architecture: "x64",
		packageRoot: join(root, "package"),
		platformPackageRoot: null,
		homeDir,
		pathValue: "C:\\Windows\\System32",
	});

	assert.equal(result.executable, binary);
	assert.equal(result.path, `${dirname(binary)};C:\\Windows\\System32`);
});

test("Windows startup preserves the existing PATH key casing", async (t) => {
	const root = await temporaryDirectory(t);
	const homeDir = join(root, "home");
	const binary = ripgrepOutputPath(
		join(homeDir, ".mycli", "vendor", "ripgrep"),
		ripgrepPlatformKey("win32", "x64"),
	);
	await writeExecutable(binary);
	const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32" };

	initializeRipgrepEnvironment({
		env,
		platform: "win32",
		architecture: "x64",
		packageRoot: join(root, "package"),
		platformPackageRoot: null,
		homeDir,
	});

	assert.equal(env.Path, `${dirname(binary)};C:\\Windows\\System32`);
	assert.equal(env.PATH, undefined);
	assert.equal(env.MYCLI_RIPGREP_PATH_DIR, dirname(binary));
});

async function writeExecutable(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
	await chmod(path, 0o755);
}

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-ripgrep-runtime-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
