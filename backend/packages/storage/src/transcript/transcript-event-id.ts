import { createHash } from "node:crypto";
import { stableJson } from "../stable-json.ts";

export function semanticTranscriptEventId(...parts: readonly string[]): string {
	const digest = createHash("sha256").update(stableJson(parts)).digest("hex");
	return `event:${digest}`;
}
