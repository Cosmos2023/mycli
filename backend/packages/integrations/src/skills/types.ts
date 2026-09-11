export type SkillSourceKind = "builtin" | "user" | "shared_repo" | "repo";

export interface SkillDefinition {
	readonly name: string;
	readonly description: string;
	readonly triggerHints: readonly string[];
	readonly envDependencies: readonly string[];
	readonly workspaceDependencies: readonly string[];
	readonly guardrails: readonly string[];
	readonly body: string;
	readonly sourceKind: SkillSourceKind;
	readonly fileLabel: string;
	readonly pluginId?: string;
}

export interface SkillDiagnosticIssue {
	readonly sourceKind: SkillSourceKind;
	readonly fileLabel: string;
	readonly errorClass: string;
}

export interface SkillRegistryDiagnostics {
	readonly directoryCount: number;
	readonly discoveredCount: number;
	readonly loadedCount: number;
	readonly duplicateCount: number;
	readonly issueCount: number;
	readonly sourceCounts: Readonly<Record<SkillSourceKind, number>>;
	readonly issues: readonly SkillDiagnosticIssue[];
}

export interface SkillInvocationArtifact {
	readonly kind: "skill_instructions";
	readonly name: string;
	readonly text: string;
	readonly sourceKind: SkillSourceKind;
	readonly contentSha256: string;
	readonly contentLength: number;
}
