import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
	const manifest = readManifest(packages[0].root);

	assert.deepEqual(manifest.bin, { mycli: "dist/cli.js" });
	assertRuntimeMetadataUsesDist(manifest);
});

test("contracts production export targets compiled JavaScript and declarations", () => {
	const manifest = readManifest(packages[1].root);

	assert.deepEqual(manifest.files, ["dist", "schemas"]);
	assert.deepEqual(manifest.exports, {
		".": {
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
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		},
		"./gateway": {
			types: "./dist/gateway.d.ts",
			import: "./dist/gateway.js",
		},
		"./gateway-transport": {
			types: "./dist/adapters/gateway-transport.d.ts",
			import: "./dist/adapters/gateway-transport.js",
		},
	});
	assert.equal(manifest.types, "./dist/index.d.ts");
	assertRuntimeMetadataUsesDist(manifest);
});

test("packed CLI smoke includes every local app and runtime dependency", () => {
	const app = readManifest(packages[0].root);
	const runtime = readManifest(new URL("../../../packages/runtime/", import.meta.url));
	const smoke = readFileSync(
		new URL("../../../../scripts/smoke_packed_cli.mjs", import.meta.url),
		"utf8",
	);
	const localDependencies = new Set([
		...Object.keys(app.dependencies ?? {}),
		...Object.keys(runtime.dependencies ?? {}),
	].filter((name) => name.startsWith("@mycli/") || name === "mycli-shell-tui"));

	for (const dependency of localDependencies) {
		assert.equal(
			smoke.includes(`"${dependency}"`),
			true,
			`pack smoke is missing ${dependency}`,
		);
	}
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
	const runtimeMetadata = JSON.stringify({
		bin: manifest.bin,
		dependencies: manifest.dependencies,
		exports: manifest.exports,
		types: manifest.types,
	});
	assert.doesNotMatch(runtimeMetadata, /tsx|--import|src\/|(?<!\.d)\.ts"/);
}
