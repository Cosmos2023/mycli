import { intersectNetworkDomains, normalizeNetworkDomains } from "./network-domain-policy.ts";

export interface NetworkProxyPolicy {
	readonly mode: "full" | "limited";
	readonly enableSocks5: boolean;
	readonly allowUpstreamProxy: boolean;
	/** Additional restriction within networkDomains, never an exception to that ceiling. */
	readonly approvalDomains?: readonly string[];
}

export function freezeNetworkProxyPolicy(value: unknown): NetworkProxyPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid network proxy policy");
	const policy = value as Partial<NetworkProxyPolicy>;
	if (Object.keys(policy).some((key) => !["mode", "enableSocks5", "allowUpstreamProxy", "approvalDomains"].includes(key))
		|| (policy.mode !== undefined && policy.mode !== "full" && policy.mode !== "limited")
		|| [policy.enableSocks5, policy.allowUpstreamProxy].some((flag) => flag !== undefined && typeof flag !== "boolean")) {
		throw new TypeError("invalid network proxy policy");
	}
	if (policy.approvalDomains !== undefined && (!Array.isArray(policy.approvalDomains) || policy.approvalDomains.length > 256)) {
		throw new TypeError("invalid network approval domains");
	}
	return Object.freeze({ mode: policy.mode ?? "full", enableSocks5: policy.enableSocks5 ?? true,
		allowUpstreamProxy: policy.allowUpstreamProxy ?? false,
		...(policy.approvalDomains === undefined ? {} : { approvalDomains: normalizeNetworkDomains(policy.approvalDomains) }) });
}

export function intersectNetworkProxyPolicy(
	left: NetworkProxyPolicy | undefined,
	right: NetworkProxyPolicy | undefined,
): NetworkProxyPolicy | undefined {
	if (!left || !right) return left || right ? freezeNetworkProxyPolicy(left ?? right) : undefined;
	return freezeNetworkProxyPolicy({ mode: left.mode === "limited" || right.mode === "limited" ? "limited" : "full",
		enableSocks5: left.enableSocks5 && right.enableSocks5,
		allowUpstreamProxy: left.allowUpstreamProxy && right.allowUpstreamProxy,
		...(left.approvalDomains === undefined && right.approvalDomains === undefined ? {} : {
			approvalDomains: [...new Set([...(left.approvalDomains ?? []), ...(right.approvalDomains ?? [])])],
		}) });
}

export function networkProxyPolicyIsSubset(candidate: NetworkProxyPolicy | undefined, ceiling: NetworkProxyPolicy | undefined): boolean {
	return !(ceiling?.mode === "limited" && candidate?.mode !== "limited")
		&& !(candidate?.enableSocks5 && !ceiling?.enableSocks5)
		&& !(candidate?.allowUpstreamProxy && !ceiling?.allowUpstreamProxy)
		&& (ceiling?.approvalDomains ?? []).every((pattern) =>
			intersectNetworkDomains([pattern], candidate?.approvalDomains ?? [])?.includes(pattern));
}

export function validateNetworkProxyPolicy(policy: {
	readonly networkProxy?: NetworkProxyPolicy;
	readonly networkDomains?: readonly string[];
	readonly networkEgress?: unknown;
	readonly allowLocalBinding?: boolean;
	readonly loopbackPorts?: readonly number[];
}): void {
	if (!policy.networkProxy) return;
	const proxy = freezeNetworkProxyPolicy(policy.networkProxy);
	if (policy.networkDomains === undefined || policy.networkEgress !== undefined) {
		throw new TypeError("network proxy options require a domain policy without structured egress");
	}
	if (proxy.mode === "limited" && (policy.allowLocalBinding === true || Boolean(policy.loopbackPorts?.length))) {
		throw new TypeError("limited networking cannot permit direct loopback access");
	}
}
