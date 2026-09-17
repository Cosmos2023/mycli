import type { ReviewSelection } from "@mycli/contracts";
import { createHash } from "node:crypto";

export interface TurnSubmissionFingerprintInput {
	readonly review?: ReviewSelection;
	readonly message?: unknown;
	readonly localImages?: unknown;
	readonly skillReferences?: readonly { readonly id: string; readonly name: string; readonly revision: string }[];
	readonly modelOverride?: unknown;
	readonly reasoningEffort?: unknown;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function imageList(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function fingerprintSubmission(input: TurnSubmissionFingerprintInput): string {
	const canonical = JSON.stringify({
		message: optionalString(input.message) ?? "",
		local_images: imageList(input.localImages),
		...(input.skillReferences?.length ? { skill_references: input.skillReferences.map(({ id, name, revision }) => ({ id, name, revision })) } : {}),
		model_override: optionalString(input.modelOverride),
		reasoning_effort: optionalString(input.reasoningEffort),
		...(input.review ? { review: { kind: input.review.kind, ...("ref" in input.review ? { ref: input.review.ref } : {}), ...("instructions" in input.review ? { instructions: input.review.instructions } : {}) } } : {}),
	});
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
