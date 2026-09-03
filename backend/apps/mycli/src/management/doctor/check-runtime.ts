import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gatewayContractCatalog } from "@mycli/contracts";
import { builtinToolManifest } from "@mycli/tools";
import { MYCLI_PACKAGE_NAME } from "../../version.ts";
import type { DoctorCheck } from "./types.ts";

const MINIMUM_NODE = Object.freeze([22, 19, 0] as const);
const REQUIRED_PACKAGES = Object.freeze([
	"backend/apps/mycli",
	"backend/packages/config",
	"backend/packages/contracts",
	"backend/packages/core",
	"backend/packages/integrations",
	"backend/packages/providers",
	"backend/packages/runtime",
	"backend/packages/storage",
	"backend/packages/tools",
	"tui/mycli-shell",
]);
const REQUIRED_VENDORED_PACKAGES = Object.freeze([
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
const REQUIRED_RPC_METHODS = Object.freeze(["extension.manifest", "trace.export", "turn.submit"]);
const REQUIRED_EVENT_STREAMS = Object.freeze(["runtime.event", "subagent.updated", "turn.status"]);

export interface RuntimeDoctorOptions {
	readonly packageRoot?: string;
	readonly appPackageRoot?: string;
	readonly nodeVersion?: string;
}

export async function collectRuntimeChecks(
	options: RuntimeDoctorOptions = {},
): Promise<readonly DoctorCheck[]> {
	const packageRoot = options.packageRoot ?? defaultPackageRoot();
	const appPackageRoot = options.appPackageRoot ?? defaultAppPackageRoot();
	return Object.freeze([
		checkNodeVersion(options.nodeVersion ?? process.versions.node),
		await checkPackageLayout(packageRoot, appPackageRoot),
		checkRuntimeContract(),
		checkToolManifest(),
	]);
}

function checkNodeVersion(version: string): DoctorCheck {
	const parsed = version.split(".").slice(0, 3).map(Number);
	const valid = parsed.length === 3
		&& parsed.every((part) => Number.isSafeInteger(part) && part >= 0);
	const supported = valid && compareVersion(parsed as [number, number, number], MINIMUM_NODE) >= 0;
	return check(
		"node_runtime",
		supported ? "ok" : "failed",
		supported ? `node=${parsed.join(".")} supported` : "Node 22.19.0 or newer is required",
	);
}

async function checkPackageLayout(root: string, appRoot: string): Promise<DoctorCheck> {
	const workspaceManifest = await packageManifest(root);
	if (!workspaceManifest || !Array.isArray(workspaceManifest.workspaces)) {
		return checkInstalledPackageLayout(appRoot);
	}
	const missing: string[] = [];
	for (const relativePath of REQUIRED_PACKAGES) {
		try {
			if (!(await stat(join(root, relativePath))).isDirectory()) missing.push(relativePath);
		} catch {
			missing.push(relativePath);
		}
	}
	return missing.length > 0
		? check("package_layout", "failed", `missing_packages=${new Set(missing).size}`)
		: check("package_layout", "ok", `packages=${REQUIRED_PACKAGES.length}`);
}

async function checkInstalledPackageLayout(appRoot: string): Promise<DoctorCheck> {
	const manifest = await packageManifest(appRoot);
	if (!manifest || manifest.name !== MYCLI_PACKAGE_NAME) {
		return check("package_layout", "failed", "application package manifest missing");
	}
	const missing: string[] = [];
	for (const name of REQUIRED_VENDORED_PACKAGES) {
		try {
			const packageRoot = join(appRoot, "dist", "node_modules", ...name.split("/"));
			if (!(await stat(packageRoot)).isDirectory()) missing.push(name);
		} catch {
			missing.push(name);
		}
	}
	return missing.length > 0
		? check("package_layout", "failed", `missing_vendored_packages=${missing.length}`)
		: check("package_layout", "ok", `vendored_packages=${REQUIRED_VENDORED_PACKAGES.length}`);
}

async function packageManifest(root: string): Promise<Readonly<Record<string, unknown>> | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function checkRuntimeContract(): DoctorCheck {
	const rpcMethods = gatewayContractCatalog.rpcMethods;
	const eventStreams = gatewayContractCatalog.eventStreams;
	const valid = gatewayContractCatalog.protocolVersion === 1
		&& unique(rpcMethods)
		&& unique(eventStreams)
		&& REQUIRED_RPC_METHODS.every((method) => rpcMethods.includes(method))
		&& REQUIRED_EVENT_STREAMS.every((method) => eventStreams.includes(method));
	return check(
		"runtime_contract",
		valid ? "ok" : "failed",
		valid
			? `rpc_methods=${rpcMethods.length} event_streams=${eventStreams.length}`
			: "gateway contract catalog invalid",
	);
}

function checkToolManifest(): DoctorCheck {
	const manifest = builtinToolManifest();
	const ids = manifest.tools.map((tool) => tool.id);
	const names = manifest.tools.map((tool) => tool.name);
	const requiredNames = ["Read", "Write", "Edit", "Patch"];
	const valid = manifest.schema_version === 1
		&& manifest.source === "builtin"
		&& unique(ids)
		&& unique(names)
		&& requiredNames.every((name) => names.includes(name))
		&& manifest.tools.every((tool) => (
			["low", "medium", "high"].includes(tool.risk_level)
			&& isRecord(tool.inputSchema)
			&& tool.availability.status === "available"
		));
	return check(
		"tool_manifest",
		valid ? "ok" : "failed",
		valid ? `tools=${manifest.tools.length} toolsets=${manifest.toolsets.length}` : "tool manifest invalid",
	);
}

function defaultPackageRoot(): string {
	return fileURLToPath(new URL("../../../../../../", import.meta.url));
}

function defaultAppPackageRoot(): string {
	return fileURLToPath(new URL("../../../", import.meta.url));
}

function compareVersion(
	left: readonly [number, number, number],
	right: readonly [number, number, number],
): number {
	for (let index = 0; index < left.length; index += 1) {
		const difference = left[index]! - right[index]!;
		if (difference !== 0) return difference;
	}
	return 0;
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
): DoctorCheck {
	return Object.freeze({ name, status, message });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
