import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type PackageManifest = {
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	exports?: unknown;
	files?: string[];
	scripts?: Record<string, string>;
	types?: string;
};

const packages = [
	{ name: "app", root: new URL("../", import.meta.url) },
	{ name: "contracts", root: new URL("../../../packages/contracts/", import.meta.url) },
	{ name: "TUI", root: new URL("../../../tui/mycli-shell/", import.meta.url) },
] as const;

test("runtime workspaces expose deterministic build scripts", () => {
	for (const workspace of packages) {
		const manifest = readManifest(workspace.root);
		assert.equal(
			manifest.scripts?.build,
			"tsc -p tsconfig.build.json",
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
		new URL("../../../scripts/smoke_packed_cli.mjs", import.meta.url),
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
