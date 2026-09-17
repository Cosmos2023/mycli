export interface ExtensionApprovalScope {
	readonly id: string;
	readonly fingerprint: string;
}

export function parseExtensionApprovalScope(value: unknown): ExtensionApprovalScope | undefined {
	if (typeof value !== "object" || value === null || !("id" in value) || !("fingerprint" in value)
		|| typeof value.id !== "string" || value.id.length > 128 || !/^(mcp|plugin):[A-Za-z0-9._:-]+$/u.test(value.id)
		|| typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) return undefined;
	return Object.freeze({ id: value.id, fingerprint: value.fingerprint });
}

export function extensionApprovalKey(scope: ExtensionApprovalScope): string {
	return `${scope.id}:${scope.fingerprint}`;
}
