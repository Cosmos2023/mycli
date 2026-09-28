import { freezeLoopbackPorts, freezeNetworkEgress, freezeNetworkProxyPolicy, type AgentExecutionPolicySnapshot } from "@mycli/core";
import type { ExecutionPolicyConstraints, ExecutionPolicySnapshot, RunExecutionSnapshot } from "@mycli/runtime";

function agentExecutionPolicySnapshot(
	snapshot: ExecutionPolicySnapshot | undefined,
): AgentExecutionPolicySnapshot {
	const profile = snapshot?.profile;
	const filesystem = profile?.filesystem ?? "read_only";
	const permission = filesystem === "unrestricted"
		? "full-access"
		: filesystem === "workspace_write"
			? "workspace"
			: "read-only";
	return Object.freeze({
		trusted: snapshot?.trusted === true && snapshot.valid,
		permission,
		sandboxMode: profile?.mode ?? "read-only",
		filesystem,
		network: profile?.network ?? "disabled",
		...(profile?.networkProxy === undefined ? {} : { networkProxy: freezeNetworkProxyPolicy(profile.networkProxy) }),
		...(profile?.networkDomains === undefined ? {} : {
			networkDomains: Object.freeze([...profile.networkDomains]),
		}),
		...(profile?.networkEgress === undefined ? {} : { networkEgress: freezeNetworkEgress(profile.networkEgress) }),
		...(profile?.deniedReadRoots === undefined ? {} : { deniedReadRoots: Object.freeze([...profile.deniedReadRoots]) }),
		...(profile?.readOnlyRoots === undefined ? {} : { readOnlyRoots: Object.freeze([...profile.readOnlyRoots]) }),
		...(profile?.allowLocalBinding === undefined ? {} : { allowLocalBinding: profile.allowLocalBinding }),
		...(profile?.loopbackPorts === undefined ? {} : { loopbackPorts: freezeLoopbackPorts(profile.loopbackPorts) }),
		...(profile?.writableTemp === undefined ? {} : { writableTemp: profile.writableTemp }),
		...(profile?.deniedReadGlobs === undefined ? {} : { deniedReadGlobs: Object.freeze([...profile.deniedReadGlobs]) }),
		...(profile?.readableRoots === undefined ? {} : {
			readableRoots: Object.freeze([...profile.readableRoots]),
		}),
		writableRoots: Object.freeze([...(profile?.writableRoots ?? [])]),
	});
}

export function agentExecutionPolicyForRun(
	snapshot: RunExecutionSnapshot | undefined,
): AgentExecutionPolicySnapshot {
	const policy = snapshot?.policy;
	if (!policy) return agentExecutionPolicySnapshot(undefined);
	return agentExecutionPolicySnapshot(Object.freeze({
		trusted: policy.toolsEnabled,
		valid: true,
		profile: policy.profile,
	}));
}

export function inheritedAgentExecutionPolicyConstraints(
	policy: AgentExecutionPolicySnapshot,
): ExecutionPolicyConstraints {
	return Object.freeze({
		source: "runtime" as const,
		network: policy.network,
		...(policy.networkProxy === undefined ? {} : { networkProxy: freezeNetworkProxyPolicy(policy.networkProxy) }),
		...(policy.networkDomains === undefined ? {} : {
			networkDomains: Object.freeze([...policy.networkDomains]),
		}),
		...(policy.networkEgress === undefined ? {} : { networkEgress: freezeNetworkEgress(policy.networkEgress) }),
		...(policy.deniedReadRoots === undefined ? {} : { deniedReadRoots: Object.freeze([...policy.deniedReadRoots]) }),
		...(policy.readOnlyRoots === undefined ? {} : { readOnlyRoots: Object.freeze([...policy.readOnlyRoots]) }),
		...(policy.allowLocalBinding === undefined ? {} : { allowLocalBinding: policy.allowLocalBinding }),
		...(policy.loopbackPorts === undefined ? {} : { loopbackPorts: freezeLoopbackPorts(policy.loopbackPorts) }),
		...(policy.writableTemp === undefined ? {} : { writableTemp: policy.writableTemp }),
		...(policy.deniedReadGlobs === undefined ? {} : { deniedReadGlobs: Object.freeze([...policy.deniedReadGlobs]) }),
		...(policy.readableRoots === undefined ? {} : {
			readableRoots: Object.freeze([...policy.readableRoots]),
		}),
		...(policy.filesystem === "unrestricted" ? {} : {
			writableRoots: Object.freeze([...policy.writableRoots]),
		}),
	});
}
