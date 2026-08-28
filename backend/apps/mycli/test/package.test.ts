import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RIPGREP_TARGETS } from "@mycli/tools";

type PackageManifest = {
	bin?: Record<string, string>;
	cpu?: string[];
	dependencies?: Record<string, string>;
	exports?: unknown;
	files?: string[];
	name?: string;
	optionalDependencies?: Record<string, string>;
	os?: string[];
	scripts?: Record<string, string>;
	types?: string;
	version?: string;
};

const ROOT = new URL("../../../../", import.meta.url);

const packages = [
	{
		name: "app",
		root: new URL("../", import.meta.url),
		build: "tsc -p tsconfig.build.json && node scripts/copy-system-prompt.mjs",
	},
	{
		name: "contracts",
		root: new URL("../../../packages/contracts/", import.meta.url),
		build: "tsc -p tsconfig.build.json",
	},
	{
		name: "TUI",
		root: new URL("../../../../tui/mycli-shell/", import.meta.url),
		build: "tsc -p tsconfig.build.json",
	},
] as const;

test("runtime workspaces expose deterministic build scripts", () => {
	for (const workspace of packages) {
		const manifest = readManifest(workspace.root);
		assert.equal(
			manifest.scripts?.build,
			workspace.build,
			`${workspace.name} build script`,
		);
		assert.doesNotThrow(() => readFileSync(new URL("tsconfig.build.json", workspace.root), "utf8"));
	}
});

test("app production bin targets compiled JavaScript", () => {
	const applicationPackageName = "@cosmos2023/mycli";
	const manifest = readManifest(packages[0].root);
	const rootManifest = readManifest(ROOT);

	assert.equal(manifest.name, applicationPackageName);
	assert.deepEqual(manifest.bin, { mycli: "dist/cli.js" });
	assert.equal(manifest.scripts?.prepack, "node scripts/vendor-internal-packages.mjs");
	assert.equal(rootManifest.dependencies?.[applicationPackageName], `^${manifest.version}`);
	assertRuntimeMetadataUsesDist(manifest);
});

test("contracts production export targets compiled JavaScript and declarations", () => {
	const manifest = readManifest(packages[1].root);

	assert.deepEqual(manifest.files, ["dist", "schemas"]);
	assert.deepEqual(manifest.exports, {
		".": {
			"mycli-source": "./src/index.ts",
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		},
	});
	assert.equal(manifest.types, "./dist/index.d.ts");
	assertRuntimeMetadataUsesDist(manifest);
});

test("TUI production exports target compiled JavaScript and declarations", () => {
	const manifest = readManifest(packages[2].root);

	assert.deepEqual(manifest.exports, {
		".": {
			"mycli-source": "./src/index.ts",
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		},
		"./gateway": {
			"mycli-source": "./src/gateway.ts",
			types: "./dist/gateway.d.ts",
			import: "./dist/gateway.js",
		},
		"./gateway-transport": {
			"mycli-source": "./src/adapters/gateway-transport.ts",
			types: "./dist/adapters/gateway-transport.d.ts",
			import: "./dist/adapters/gateway-transport.js",
		},
	});
	assert.equal(manifest.types, "./dist/index.d.ts");
	assertRuntimeMetadataUsesDist(manifest);
});

test("root commands separate the compiled CLI from source development", () => {
	const rootManifest = readManifest(ROOT);
	assert.equal(
		rootManifest.scripts?.dev,
		"node --conditions=mycli-source --import tsx backend/apps/mycli/src/cli.ts",
	);
	assert.equal(rootManifest.scripts?.mycli, "node backend/apps/mycli/dist/cli.js");
});

test("milestone regression commands are Node-only", () => {
	const scripts = readManifest(ROOT).scripts ?? {};
	const expected = {
		"test:m2": "npm run build && node --import tsx --test backend/apps/mycli/test/node-backend.integration.test.ts backend/apps/mycli/test/m2-smoke-runner.integration.test.ts",
		"test:m3": "npm run build && node --import tsx --test backend/apps/mycli/test/m3-read-turn.integration.test.ts",
		"test:m4": "npm run build && node --import tsx --test backend/apps/mycli/test/m4-file-mutation.integration.test.ts",
		"test:m5": "npm run build && node --import tsx --test backend/apps/mycli/test/m5-state-recovery.integration.test.ts",
		"test:m6": "npm run build && node --import tsx --test backend/apps/mycli/test/m6-persistent-shell.integration.test.ts",
		"test:m7": "npm run build && node --import tsx --test backend/apps/mycli/test/m7-extensions.integration.test.ts",
	};

	assert.deepEqual(
		Object.fromEntries(Object.keys(expected).map((name) => [name, scripts[name]])),
		expected,
	);
	for (const command of Object.values(expected)) {
		assert.doesNotMatch(command, /\b(?:python|pytest|uv)\b|\.py\b/u);
	}
});

test("repository excludes the retired Python product and toolchain", () => {
	for (const path of [
		"src/mycli/",
		"tests/unit/",
		"tests/integration/",
		"tests/support/",
		"evaluation/",
		"pyproject.toml",
		"uv.lock",
		".python-version",
		"hatch_build.py",
		"hatch_build_utils.py",
		"scripts/check_qwen_cache.py",
		"scripts/check_sub2api_cache.py",
		"scripts/demo_responses_cache.py",
		"scripts/prepare_ripgrep.py",
		"scripts/probe_codex_responses_transport_cache.py",
		"scripts/probe_mycli_runtime_cache.py",
		"scripts/probe_subagent_profiles.py",
		"backend/packages/storage/test/python-parity.test.ts",
	]) {
		assert.equal(existsSync(new URL(path, ROOT)), false, `${path} must stay retired`);
	}
	const sessionCorpusTest = readFileSync(
		new URL("backend/packages/storage/test/session-corpus.test.ts", ROOT),
		"utf8",
	);
	assert.doesNotMatch(sessionCorpusTest, /\b(?:python3?|PYTHONPATH)\b|from mycli\./iu);
});

test("cross-platform CI has no Python reference or wheel gate", () => {
	const workflow = readFileSync(new URL(".github/workflows/cross-platform.yml", ROOT), "utf8");
	for (const retiredMarker of [
		"python-reference-gate:",
		"astral-sh/setup-uv",
		"src/mycli/native",
		"uv sync",
		"uv build --wheel",
	]) {
		assert.equal(workflow.includes(retiredMarker), false, retiredMarker);
	}
	assert.match(workflow, /^ {2}node-m8-gate:$/mu);
	assert.match(workflow, /^ {2}windows-sandbox-helper:$/mu);
	assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-2022\]/u);
	assert.match(workflow, /apparmor_restrict_unprivileged_userns=0/u);
});

test("compiled CLI does not load the backend implementation on the supervisor thread", () => {
	const compiled = readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8");
	assert.doesNotMatch(compiled, /from ["']\.\/node-runtime\/node-backend\.js["']/u);
});

test("root development command resolves every workspace package from source", () => {

	const packageNames = [
		"@mycli/config",
		"@mycli/contracts",
		"@mycli/core",
		"@mycli/integrations",
		"@mycli/providers",
		"@mycli/runtime",
		"@mycli/storage",
		"@mycli/tools",
		"@mycli/tools/ripgrep-runtime",
		"mycli-shell-tui",
		"mycli-shell-tui/gateway",
		"mycli-shell-tui/gateway-transport",
	] as const;
	const script = `process.stdout.write(JSON.stringify(${JSON.stringify(packageNames)}.map((name) => import.meta.resolve(name))))`;
	const resolved = JSON.parse(execFileSync(
		process.execPath,
		["--conditions=mycli-source", "--input-type=module", "--eval", script],
		{ cwd: fileURLToPath(ROOT), encoding: "utf8" },
	)) as string[];

	for (const [index, value] of resolved.entries()) {
		assert.match(value, /\/(?:backend\/packages\/[^/]+|tui\/mycli-shell)\/src\//u, packageNames[index]);
		assert.match(value, /\.ts$/u, packageNames[index]);
	}
});

test("default workspace imports keep production packages on compiled output", () => {
	const script = `process.stdout.write(JSON.stringify([
		import.meta.resolve('mycli-shell-tui/gateway-transport'),
		import.meta.resolve('@mycli/tools/ripgrep-runtime'),
	]))`;
	const resolved = execFileSync(
		process.execPath,
		["--input-type=module", "--eval", script],
		{ cwd: fileURLToPath(ROOT), encoding: "utf8" },
	);

	const [gatewayTransport, ripgrepRuntime] = JSON.parse(resolved) as string[];
	assert.match(gatewayTransport ?? "", /\/tui\/mycli-shell\/dist\/adapters\/gateway-transport\.js$/u);
	assert.match(ripgrepRuntime ?? "", /\/backend\/packages\/tools\/dist\/ripgrep-runtime\.js$/u);
});

test("packed CLI smoke vendors internal workspaces into the application tarball", () => {
	const app = readManifest(packages[0].root);
	const root = readManifest(ROOT);
	const smoke = readFileSync(
		new URL("../../../../scripts/smoke_packed_cli.mjs", import.meta.url),
		"utf8",
	);
	const releaseConfig = readFileSync(
		new URL("../../../../scripts/release-config.mjs", import.meta.url),
		"utf8",
	);
	const localDependencies = new Set([
		"@mycli/config",
		"@mycli/contracts",
		"@mycli/core",
		"@mycli/integrations",
		"@mycli/providers",
		"@mycli/runtime",
		"@mycli/storage",
		"@mycli/tools",
		"mycli-shell-tui",
	]);

	for (const dependency of localDependencies) {
		assert.equal(app.dependencies?.[dependency], undefined, `${dependency} must be vendored`);
		assert.equal(
			releaseConfig.includes(`"${dependency}"`),
			true,
			`release package list is missing ${dependency}`,
		);
	}
	assert.equal(root.scripts?.["smoke:package"], "node scripts/smoke_packed_cli.mjs");
	assert.match(smoke, /APPLICATION_RELEASE_PACKAGE\.name/u);
	assert.match(smoke, /APPLICATION_PACKAGE_MODULE_PATH/u);
	assert.doesNotMatch(smoke, /node_modules\/@cosmos2023\/app/u);
	assert.match(smoke, /VENDORED_WORKSPACE_PACKAGES/u);
	assert.match(smoke, /FLAGS\.has\("--all-platforms"\)/u);
	assert.match(smoke, /name === CURRENT_PLATFORM_PACKAGE/u);
	assert.match(smoke, /native\/windows\/mycli-windows-sandbox\.exe/u);
});

test("tools optional dependencies match every ripgrep platform package", () => {
	const tools = readManifest(new URL("../../../packages/tools/", import.meta.url));
	const expected = Object.fromEntries(Object.values(RIPGREP_TARGETS).map((target) => [
		target.npmPackage,
		tools.version,
	]));
	assert.deepEqual(tools.optionalDependencies, expected);

	for (const [target, info] of Object.entries(RIPGREP_TARGETS)) {
		const manifest = readManifest(new URL(`../../../../npm/ripgrep/${target}/`, import.meta.url));
		assert.equal(manifest.name, info.npmPackage);
		assert.equal(manifest.version, tools.version);
		assert.deepEqual(manifest.os, [info.npmOs]);
		assert.deepEqual(manifest.cpu, [info.npmCpu]);
		assert.deepEqual(manifest.files, ["vendor"]);
		assert.match(manifest.scripts?.prepack ?? "", new RegExp(`stage ${target}$`, "u"));
		assert.match(manifest.scripts?.postpack ?? "", new RegExp(`clean ${target}$`, "u"));
	}
});

function readManifest(root: URL): PackageManifest {
	return JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as PackageManifest;
}

function assertRuntimeMetadataUsesDist(manifest: PackageManifest): void {
	const exports = manifest.exports && typeof manifest.exports === "object"
		? Object.fromEntries(Object.entries(manifest.exports).map(([name, value]) => {
			if (!value || typeof value !== "object") return [name, value];
			const production = { ...(value as Record<string, unknown>) };
			delete production["mycli-source"];
			return [name, production];
		}))
		: manifest.exports;
	const runtimeMetadata = JSON.stringify({
		bin: manifest.bin,
		dependencies: manifest.dependencies,
		exports,
		types: manifest.types,
	});
	assert.doesNotMatch(runtimeMetadata, /tsx|--import|src\/|(?<!\.d)\.ts"/);
}
