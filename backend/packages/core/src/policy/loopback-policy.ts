export const MAX_LOOPBACK_PORTS = 64;

export interface LoopbackAccess {
	readonly allowLocalBinding?: boolean;
	readonly loopbackPorts?: readonly number[];
}

/** Undefined preserves the legacy boolean; an explicit empty list denies extra ports. */
export function freezeLoopbackPorts(value: unknown): readonly number[] {
	if (!Array.isArray(value) || value.length > MAX_LOOPBACK_PORTS
		|| [...value].some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
		throw new TypeError("loopback_ports must contain at most 64 integer TCP ports between 1 and 65535");
	}
	return Object.freeze([...new Set(value as number[])].sort((left, right) => left - right));
}

export function loopbackAccessIsSubset(candidate: LoopbackAccess, ceiling: LoopbackAccess): boolean {
	const candidatePorts = candidate.loopbackPorts === undefined ? undefined : freezeLoopbackPorts(candidate.loopbackPorts);
	const ceilingPorts = ceiling.loopbackPorts === undefined ? undefined : freezeLoopbackPorts(ceiling.loopbackPorts);
	if (ceilingPorts === undefined && ceiling.allowLocalBinding === true) return true;
	if (candidatePorts === undefined && candidate.allowLocalBinding === true) return false;
	return (candidatePorts ?? []).every((port) => ceilingPorts?.includes(port));
}

/** Intersect frozen authority with current limits; neither side may expand the other. */
export function intersectLoopbackAccess(current: LoopbackAccess, ceiling: LoopbackAccess): LoopbackAccess {
	const result = loopbackAccessIsSubset(current, ceiling) ? current
		: loopbackAccessIsSubset(ceiling, current) ? ceiling
			: { loopbackPorts: current.loopbackPorts?.filter((port) => ceiling.loopbackPorts?.includes(port)) ?? [] };
	if (current.loopbackPorts === undefined && ceiling.loopbackPorts === undefined) return result;
	return Object.freeze({ ...result, loopbackPorts: freezeLoopbackPorts(result.loopbackPorts ?? []) });
}

export function validateLoopbackPortPolicy(policy: LoopbackAccess & {
	readonly networkDomains?: readonly string[];
	readonly networkEgress?: unknown;
}): void {
	if (policy.loopbackPorts === undefined) return;
	freezeLoopbackPorts(policy.loopbackPorts);
	if (policy.networkDomains === undefined || policy.networkEgress !== undefined) {
		throw new TypeError("loopback_ports requires allowed_network_domains and cannot be combined with network_egress");
	}
}
