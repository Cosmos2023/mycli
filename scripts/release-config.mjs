#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function releasePackage(name, relativePath, workspace) {
	return Object.freeze({ name, relativePath, workspace });
}

export const PLATFORM_RELEASE_PACKAGES = Object.freeze([
	releasePackage("@cosmos2023/ripgrep-darwin-arm64", "npm/ripgrep/macos-aarch64", false),
	releasePackage("@cosmos2023/ripgrep-darwin-x64", "npm/ripgrep/macos-x86_64", false),
	releasePackage("@cosmos2023/ripgrep-linux-arm64", "npm/ripgrep/linux-aarch64", false),
	releasePackage("@cosmos2023/ripgrep-linux-x64", "npm/ripgrep/linux-x86_64", false),
	releasePackage("@cosmos2023/ripgrep-win32-arm64", "npm/ripgrep/windows-aarch64", false),
	releasePackage("@cosmos2023/ripgrep-win32-x64", "npm/ripgrep/windows-x86_64", false),
]);

export const VENDORED_WORKSPACE_PACKAGES = Object.freeze([
	releasePackage("@mycli/contracts", "backend/packages/contracts", true),
	releasePackage("@mycli/core", "backend/packages/core", true),
	releasePackage("@mycli/config", "backend/packages/config", true),
	releasePackage("@mycli/tools", "backend/packages/tools", true),
	releasePackage("@mycli/providers", "backend/packages/providers", true),
	releasePackage("@mycli/storage", "backend/packages/storage", true),
	releasePackage("@mycli/integrations", "backend/packages/integrations", true),
	releasePackage("@mycli/runtime", "backend/packages/runtime", true),
	releasePackage("mycli-shell-tui", "tui/mycli-shell", true),
]);

export const APPLICATION_RELEASE_PACKAGE = releasePackage(
	"@cosmos2023/mycli",
	"backend/apps/mycli",
	true,
);

export const RELEASE_PACKAGES = Object.freeze([
	...PLATFORM_RELEASE_PACKAGES,
	APPLICATION_RELEASE_PACKAGE,
]);

export const VERSIONED_PACKAGES = Object.freeze([
	...PLATFORM_RELEASE_PACKAGES,
	...VENDORED_WORKSPACE_PACKAGES,
	APPLICATION_RELEASE_PACKAGE,
]);

export const VERSIONED_PACKAGE_NAMES = new Set(VERSIONED_PACKAGES.map(({ name }) => name));

export function releasePackagePath(releasePackage, root = RELEASE_ROOT) {
	return join(root, releasePackage.relativePath);
}

export function releaseManifestPath(releasePackage, root = RELEASE_ROOT) {
	return join(releasePackagePath(releasePackage, root), "package.json");
}
