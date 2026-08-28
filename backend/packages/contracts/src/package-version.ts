export interface PackageVersionManifest {
	readonly version?: unknown;
}

export function parsePackageVersion(manifest: unknown): string {
	if (typeof manifest !== "object" || manifest === null) {
		throw new Error("package_version_invalid");
	}
	const version = (manifest as PackageVersionManifest).version;
	if (typeof version !== "string" || version === "") throw new Error("package_version_invalid");
	return version;
}
