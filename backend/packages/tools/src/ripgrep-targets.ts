import { join } from "node:path";

export const RIPGREP_VERSION = "15.1.0";

export interface RipgrepTargetInfo {
	readonly archive: string;
	readonly member: string;
	readonly npmPackage: string;
	readonly npmCpu: "arm64" | "x64";
	readonly npmOs: "darwin" | "linux" | "win32";
	readonly sha256: string;
}

export const RIPGREP_TARGETS = Object.freeze({
	"macos-aarch64": Object.freeze({
		archive: "ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
		member: "ripgrep-15.1.0-aarch64-apple-darwin/rg",
		npmPackage: "@mycli/ripgrep-darwin-arm64",
		npmCpu: "arm64",
		npmOs: "darwin",
		sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
	}),
	"macos-x86_64": Object.freeze({
		archive: "ripgrep-15.1.0-x86_64-apple-darwin.tar.gz",
		member: "ripgrep-15.1.0-x86_64-apple-darwin/rg",
		npmPackage: "@mycli/ripgrep-darwin-x64",
		npmCpu: "x64",
		npmOs: "darwin",
		sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
	}),
	"linux-aarch64": Object.freeze({
		archive: "ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz",
		member: "ripgrep-15.1.0-aarch64-unknown-linux-gnu/rg",
		npmPackage: "@mycli/ripgrep-linux-arm64",
		npmCpu: "arm64",
		npmOs: "linux",
		sha256: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
	}),
	"linux-x86_64": Object.freeze({
		archive: "ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
		member: "ripgrep-15.1.0-x86_64-unknown-linux-musl/rg",
		npmPackage: "@mycli/ripgrep-linux-x64",
		npmCpu: "x64",
		npmOs: "linux",
		sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
	}),
	"windows-aarch64": Object.freeze({
		archive: "ripgrep-15.1.0-aarch64-pc-windows-msvc.zip",
		member: "ripgrep-15.1.0-aarch64-pc-windows-msvc/rg.exe",
		npmPackage: "@mycli/ripgrep-win32-arm64",
		npmCpu: "arm64",
		npmOs: "win32",
		sha256: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
	}),
	"windows-x86_64": Object.freeze({
		archive: "ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
		member: "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe",
		npmPackage: "@mycli/ripgrep-win32-x64",
		npmCpu: "x64",
		npmOs: "win32",
		sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
	}),
} satisfies Readonly<Record<string, RipgrepTargetInfo>>);

export type RipgrepTarget = keyof typeof RIPGREP_TARGETS;

export function ripgrepPlatformKey(
	platform: NodeJS.Platform | string = process.platform,
	architecture: string = process.arch,
): RipgrepTarget {
	const normalizedPlatform = normalizePlatform(platform);
	const normalizedArchitecture = normalizeArchitecture(architecture);
	const target = `${normalizedPlatform}-${normalizedArchitecture}`;
	if (!isRipgrepTarget(target)) throw new Error(`unsupported ripgrep target: ${target}`);
	return target;
}

export function isRipgrepTarget(value: string): value is RipgrepTarget {
	return Object.hasOwn(RIPGREP_TARGETS, value);
}

export function ripgrepOutputPath(destinationRoot: string, target: RipgrepTarget): string {
	return join(destinationRoot, target, target.startsWith("windows-") ? "rg.exe" : "rg");
}

function normalizePlatform(platform: string): "linux" | "macos" | "windows" {
	switch (platform.toLowerCase()) {
		case "darwin":
		case "macos":
			return "macos";
		case "linux":
			return "linux";
		case "win32":
		case "windows":
			return "windows";
		default:
			throw new Error(`unsupported ripgrep platform: ${platform}`);
	}
}

function normalizeArchitecture(architecture: string): "aarch64" | "x86_64" {
	switch (architecture.toLowerCase()) {
		case "arm64":
		case "aarch64":
			return "aarch64";
		case "x64":
		case "amd64":
		case "x86_64":
			return "x86_64";
		default:
			throw new Error(`unsupported ripgrep architecture: ${architecture}`);
	}
}
