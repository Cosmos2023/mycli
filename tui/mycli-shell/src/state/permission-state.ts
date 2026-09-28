import type { PermissionBounds, SandboxCapabilities } from "@mycli/contracts";
import type { MycliShellPermissionProfile, MycliShellPermissionState } from "../model.ts";
import { booleanValue, numberValue, recordValue, stringValue } from "./payload-values.ts";

export function permissionStateFromUnknown(value: unknown): MycliShellPermissionState | null {
	const record = recordValue(value);
	const active = permissionProfileId(record.active);
	const profiles = Array.isArray(record.profiles)
		? record.profiles.map(permissionProfileFromUnknown).filter((profile): profile is MycliShellPermissionProfile => profile !== null)
		: [];
	if (!active || profiles.length === 0) return null;
	return {
		active,
		profiles,
		commandAllowanceCount: Math.max(0, numberValue(record.command_allowance_count) ?? numberValue(record.commandAllowanceCount) ?? 0),
		...(permissionEffectiveFromUnknown(record.effective) ?? {}),
		...(sandboxReadinessFromUnknown(record.sandbox_readiness ?? record.sandboxReadiness) ?? {}),
		...(sandboxCapabilitiesFromUnknown(record.sandbox_capabilities) ?? {}),
	};
}

function permissionEffectiveFromUnknown(
	value: unknown,
): Pick<MycliShellPermissionState, "effective"> | null {
	const record = recordValue(value);
	const trusted = booleanValue(record.trusted);
	const valid = booleanValue(record.valid);
	const sandboxMode = sandboxModeValue(record.sandbox_mode ?? record.sandboxMode);
	const filesystem = filesystemPolicyValue(record.filesystem);
	const network = networkPolicyValue(record.network);
	const approvalBehavior = approvalBehaviorValue(record.approval_behavior ?? record.approvalBehavior);
	const source = policySourceValue(record.source);
	const constrained = booleanValue(record.constrained);
	if (trusted === null || valid === null || !sandboxMode || !filesystem || !network
		|| !approvalBehavior || !source || constrained === null) return null;
	return {
		effective: {
			trusted,
			valid,
			sandboxMode,
			filesystem,
			network,
			approvalBehavior,
			source,
			constrained,
			constraintsSource: constraintsSourceValue(
				record.constraints_source ?? record.constraintsSource,
			) ?? undefined,
			readableRoots: nonNegativeCount(record.readable_roots ?? record.readableRoots),
			writableRoots: nonNegativeCount(record.writable_roots ?? record.writableRoots),
			networkDomains: nonNegativeCount(record.network_domains ?? record.networkDomains),
			sessionGrant: booleanValue(record.session_grant ?? record.sessionGrant) ?? false,
			turnGrant: booleanValue(record.turn_grant ?? record.turnGrant) ?? false,
			...(permissionBoundsFromUnknown(record.bounds) ?? {}),
		},
	};
}

function sandboxCapabilitiesFromUnknown(value: unknown): Pick<MycliShellPermissionState, "sandboxCapabilities"> | null {
	const record = recordValue(value);
	const support = (input: unknown): SandboxCapabilities["filesystem_rules"] | null =>
		input === "supported" || input === "unsupported" || input === "unknown" ? input : null;
	const filesystem = support(record.filesystem_rules);
	const denied = support(record.denied_reads);
	const egress = support(record.structured_egress);
	const independent = support(record.independent_policies);
	const loopback = support(record.host_loopback_access);
	if (!filesystem || !denied || !egress || !independent || !loopback) return null;
	return { sandboxCapabilities: {
		filesystem_rules: filesystem, denied_reads: denied, structured_egress: egress,
		independent_policies: independent, host_loopback_access: loopback,
	} };
}

function permissionBoundsFromUnknown(value: unknown): { bounds: PermissionBounds } | null {
	const record = recordValue(value);
	const read = record.read_scope;
	const network = record.network_scope;
	const readonlyRoots = record.readonly_roots;
	const deniedRules = record.denied_read_rules;
	const ports = record.loopback_ports;
	if ((read !== "platform_default" && read !== "allowlist")
		|| (network !== "disabled" && network !== "unrestricted" && network !== "domain_allowlist" && network !== "structured_egress")
		|| typeof readonlyRoots !== "number" || !Number.isSafeInteger(readonlyRoots) || readonlyRoots < 0
		|| typeof deniedRules !== "number" || !Number.isSafeInteger(deniedRules) || deniedRules < 0
		|| typeof record.allow_local_binding !== "boolean") return null;
	if (ports !== undefined && (!Array.isArray(ports) || ports.length > 64
		|| ports.some((port) => typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535)
		|| new Set(ports).size !== ports.length)) return null;
	return { bounds: {
		read_scope: read, network_scope: network, readonly_roots: readonlyRoots,
		denied_read_rules: deniedRules, allow_local_binding: record.allow_local_binding,
		...(ports === undefined ? {} : { loopback_ports: [...ports] as number[] }),
	} };
}

function sandboxReadinessFromUnknown(
	value: unknown,
): Pick<MycliShellPermissionState, "sandboxReadiness"> | null {
	const record = recordValue(value);
	const state = sandboxReadinessStateValue(record.state);
	const code = sandboxReadinessCodeValue(record.code);
	const platform = stringValue(record.platform);
	const isolation = sandboxIsolationValue(record.isolation);
	if (!state || !code || !platform || !isolation) return null;
	return { sandboxReadiness: { state, code, platform, isolation } };
}

function permissionProfileFromUnknown(value: unknown): MycliShellPermissionProfile | null {
	const record = recordValue(value);
	const id = permissionProfileId(record.id);
	const label = stringValue(record.label);
	const description = stringValue(record.description);
	if (!id || !label || !description) return null;
	return {
		id,
		label,
		description,
		current: record.current === true,
		disabledReason: stringValue(record.disabled_reason) ?? stringValue(record.disabledReason) ?? undefined,
		sandboxMode: sandboxModeValue(record.sandbox_mode ?? record.sandboxMode) ?? undefined,
		filesystem: filesystemPolicyValue(record.filesystem) ?? undefined,
		network: networkPolicyValue(record.network) ?? undefined,
		approvalBehavior: approvalBehaviorValue(
			record.approval_behavior ?? record.approvalBehavior,
		) ?? undefined,
	};
}

function sandboxModeValue(value: unknown): NonNullable<MycliShellPermissionProfile["sandboxMode"]> | null {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
		? value
		: null;
}

function filesystemPolicyValue(value: unknown): NonNullable<MycliShellPermissionProfile["filesystem"]> | null {
	return value === "read_only" || value === "workspace_write" || value === "unrestricted"
		? value
		: null;
}

function networkPolicyValue(value: unknown): NonNullable<MycliShellPermissionProfile["network"]> | null {
	return value === "disabled" || value === "enabled" ? value : null;
}

function approvalBehaviorValue(value: unknown): NonNullable<MycliShellPermissionProfile["approvalBehavior"]> | null {
	return value === "on-request" || value === "never" ? value : null;
}

function policySourceValue(value: unknown): NonNullable<MycliShellPermissionState["effective"]>["source"] | null {
	return value === "default" || value === "user" || value === "project"
		|| value === "session" || value === "managed" ? value : null;
}

function constraintsSourceValue(value: unknown): "managed" | "runtime" | null {
	return value === "managed" || value === "runtime" ? value : null;
}

function sandboxReadinessStateValue(value: unknown): NonNullable<MycliShellPermissionState["sandboxReadiness"]>["state"] | null {
	return value === "ready" || value === "setup_required" || value === "unavailable"
		|| value === "not_required" ? value : null;
}

function sandboxReadinessCodeValue(value: unknown): NonNullable<MycliShellPermissionState["sandboxReadiness"]>["code"] | null {
	return value === "ready" || value === "setup_incomplete" || value === "helper_missing"
		|| value === "handshake_failed" || value === "enforcement_unavailable"
		|| value === "unsupported_platform" || value === "not_required" ? value : null;
}

function sandboxIsolationValue(value: unknown): NonNullable<MycliShellPermissionState["sandboxReadiness"]>["isolation"] | null {
	return value === "macos_seatbelt" || value === "linux_bubblewrap"
		|| value === "windows_restricted_token" || value === "windows_psec" || value === "none" ? value : null;
}

function nonNegativeCount(value: unknown): number {
	const count = numberValue(value);
	return count === null ? 0 : Math.max(0, Math.floor(count));
}

function permissionProfileId(value: unknown): MycliShellPermissionProfile["id"] | null {
	return value === "read-only" || value === "workspace" || value === "full-access" ? value : null;
}
