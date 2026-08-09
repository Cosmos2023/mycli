import { createHash } from "node:crypto";

export interface TurnSubmissionFingerprintInput {
	readonly message?: unknown;
	readonly localImages?: unknown;
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
		model_override: optionalString(input.modelOverride),
		reasoning_effort: optionalString(input.reasoningEffort),
	});
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
