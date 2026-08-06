export type SubagentProfileSourceKind = "builtin" | "user" | "repo";
export type SubagentProfileSourceDirectory = "builtin" | "subagents" | "agents";

export interface SubagentBudget {
	readonly maxTurns?: number;
	readonly maxToolCalls?: number;
	readonly noProgressTurnLimit?: number;
}

export interface SubagentProfile {
	readonly id: string;
	readonly description: string;
	readonly prompt: string;
	readonly model?: string;
	readonly allowedTools: readonly string[];
	readonly deniedTools: readonly string[];
	readonly budget: SubagentBudget;
	readonly sourceKind: SubagentProfileSourceKind;
	readonly sourceDirectory: SubagentProfileSourceDirectory;
	readonly fileLabel: string;
}

export interface SubagentProfileIssue {
	readonly profileId: string;
	readonly sourceKind: SubagentProfileSourceKind;
	readonly fileLabel: string;
	readonly errorClass: string;
}

export interface SubagentProfileRecord {
	readonly id: string;
	readonly status: "enabled" | "disabled" | "failed";
	readonly enabled: boolean;
	readonly sourceKind: SubagentProfileSourceKind;
	readonly sourceDirectory: SubagentProfileSourceDirectory;
	readonly fileLabel: string;
	readonly profile?: SubagentProfile;
	readonly issues: readonly SubagentProfileIssue[];
}

export interface SubagentProfileRegistryDiagnostics {
	readonly discoveredCount: number;
	readonly loadedCount: number;
	readonly enabledCount: number;
	readonly disabledCount: number;
	readonly duplicateCount: number;
	readonly issueCount: number;
	readonly issues: readonly SubagentProfileIssue[];
}
