import type { SandboxCapabilities } from "../generated/gateway-rpc.ts";

/** Fixed, value-free descriptions shared by management and terminal surfaces. */
export function sandboxCapabilityLines(capabilities: SandboxCapabilities): readonly string[] {
	return [
		`Custom read roots and read-only subtrees: ${capabilities.filesystem_rules}`,
		`Denied-read rules: ${capabilities.denied_reads}`,
		`Structured network allowlists (deny by default): ${capabilities.structured_egress}`,
		`Overlapping commands with independent file policies: ${capabilities.independent_policies}`,
		`Host access to sandbox local servers: ${capabilities.host_loopback_access}`,
		"Backend support only; readiness does not verify isolation or approve the current policy.",
	];
}
