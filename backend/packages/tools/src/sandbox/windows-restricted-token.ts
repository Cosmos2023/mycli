import { resolveDeniedReadRoots } from "../policy/denied-read-policy.ts";
import {
	hasUnrestrictedNetwork,
	type NetworkEgressRule,
	type SandboxProfile,
	type NetworkEgressPolicy,
	type NetworkRuleProtocol,
} from "../policy/execution-policy.ts";
import type { ProcessNetworkProxy, SandboxedProcessLaunch } from "./process-sandbox.ts";
import { ProcessSandboxError } from "./process-sandbox-error.ts";

export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 2;

/** The native parser consumes every field, including empty deny lists. */
export interface WindowsSandboxRequest {
	readonly protocol_version: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
	readonly command: { readonly argv: readonly string[] };
	readonly cwd: string;
	readonly workspace_roots: readonly string[];
	readonly writable_roots: readonly string[];
	readonly readable_roots?: readonly string[];
	readonly readonly_roots?: readonly string[];
	readonly allow_local_binding?: boolean;
	readonly writable_tmp?: boolean;
	readonly denied_read_roots: readonly string[];
	readonly denied_read_globs: readonly string[];
	readonly filesystem: SandboxProfile["filesystem"];
	readonly network: "enabled" | "disabled";
	readonly network_proxy_port?: number;
	readonly network_egress?: {
		readonly default: "allow" | "deny";
		readonly allow?: readonly WindowsSandboxEgressRule[];
		readonly deny?: readonly WindowsSandboxEgressRule[];
	};
	readonly mode: SandboxProfile["mode"];
}

interface WindowsSandboxEgressRule {
	readonly to: readonly {
		readonly cidr: string;
		readonly except?: readonly string[];
	}[];
	readonly ports?: readonly {
		readonly protocol?: NetworkRuleProtocol;
		readonly port?: number;
		readonly end_port?: number;
	}[];
}

export function windowsRestrictedTokenLaunch(
	executable: string,
	argv: readonly string[],
	profile: SandboxProfile,
	networkProxy?: ProcessNetworkProxy,
): SandboxedProcessLaunch {
	const networkEgress = windowsSandboxEgress(profile, networkProxy);
	const networkEnabled = networkProxy !== undefined
		|| (profile.network === "enabled"
			&& (profile.networkEgress !== undefined || hasUnrestrictedNetwork(profile)));
	const request: WindowsSandboxRequest = {
		protocol_version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
		command: { argv: [...argv] },
		cwd: profile.cwd,
		workspace_roots: [profile.workspaceRoot],
		writable_roots: [...profile.writableRoots],
		...(profile.readableRoots === undefined ? {} : { readable_roots: [...profile.readableRoots] }),
		...(profile.readOnlyRoots === undefined ? {} : { readonly_roots: [...profile.readOnlyRoots] }),
		...(profile.allowLocalBinding === undefined ? {} : { allow_local_binding: profile.allowLocalBinding }),
		...(profile.writableTemp === undefined ? {} : { writable_tmp: profile.writableTemp }),
		denied_read_roots: resolveDeniedReadRoots(profile.workspaceRoot, profile),
		denied_read_globs: [],
		filesystem: profile.filesystem,
		network: networkEnabled ? "enabled" : "disabled",
		...(networkProxy ? { network_proxy_port: networkProxy.port } : {}),
		...(networkEgress === undefined ? {} : { network_egress: networkEgress }),
		mode: profile.mode,
	};
	const json = JSON.stringify(request);
	if (Buffer.byteLength(json, "utf8") > 1_000_000) {
		throw new ProcessSandboxError("sandbox_unavailable", "Windows sandbox request exceeds its payload limit.");
	}
	if (json.length > 12_000) {
		const encoded = Buffer.from(json, "utf8").toString("base64");
		const count = Math.ceil(encoded.length / 4096);
		const env: Record<string, string> = { MYCLI_SANDBOX_REQUEST_COUNT: String(count) };
		for (let index = 0; index < count; index += 1) {
			env[`MYCLI_SANDBOX_REQUEST_${index}`] = encoded.slice(index * 4096, (index + 1) * 4096);
		}
		return Object.freeze({ executable, args: Object.freeze(["--request-env"]), env: Object.freeze(env), isolation: "windows_native" });
	}
	return Object.freeze({
		executable,
		args: Object.freeze(["--request-json", json]),
		isolation: "windows_native",
	});
}

function windowsSandboxEgress(
	profile: SandboxProfile,
	networkProxy: ProcessNetworkProxy | undefined,
): WindowsSandboxRequest["network_egress"] {
	const policy: NetworkEgressPolicy | undefined = profile.networkEgress;
	if (policy === undefined) return undefined;
	if (profile.network !== "enabled" || profile.networkDomains !== undefined || networkProxy !== undefined) {
		throw new ProcessSandboxError("sandbox_unavailable",
			"Rich network egress rules cannot be combined with disabled networking, domain filtering, or a managed proxy.");
	}
	return Object.freeze({
		default: policy.default,
		...(policy.allow === undefined ? {} : {
			allow: Object.freeze(policy.allow.map(windowsSandboxEgressRule)),
		}),
		...(policy.deny === undefined ? {} : {
			deny: Object.freeze(policy.deny.map(windowsSandboxEgressRule)),
		}),
	});
}

function windowsSandboxEgressRule(rule: NetworkEgressRule): WindowsSandboxEgressRule {
	return Object.freeze({
		to: Object.freeze(rule.to.map((destination) => Object.freeze({
			cidr: destination.cidr,
			...(destination.except === undefined ? {} : { except: Object.freeze([...destination.except]) }),
		}))),
		...(rule.ports === undefined ? {} : {
			ports: Object.freeze(rule.ports.map((port) => Object.freeze({
				...(port.protocol === undefined ? {} : { protocol: port.protocol }),
				...(port.port === undefined ? {} : { port: port.port }),
				...(port.endPort === undefined ? {} : { end_port: port.endPort }),
			}))),
		}),
	});
}
