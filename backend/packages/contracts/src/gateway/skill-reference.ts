import type { GatewayResult } from "./rpc.ts";

export type SkillReference = Pick<GatewayResult<"skills.list">["skills"][number], "id" | "name" | "revision">;
export const MAX_SKILL_REFERENCES = 8;

export function parseSkillReferences(value: unknown): readonly SkillReference[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.length > MAX_SKILL_REFERENCES) throw new TypeError("Invalid skill references.");
	const references = value.map((entry: unknown): SkillReference => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid skill reference.");
		const item = entry as Record<string, unknown>;
		if (Object.keys(item).some((key) => !["id", "name", "revision"].includes(key))
			|| typeof item.id !== "string" || !/^[a-f0-9]{64}$/u.test(item.id)
			|| typeof item.revision !== "string" || !/^[a-f0-9]{64}$/u.test(item.revision)
			|| typeof item.name !== "string" || !/^[a-z0-9][a-z0-9_:@.-]{0,255}$/u.test(item.name)) {
			throw new TypeError("Invalid skill reference.");
		}
		return Object.freeze({ id: item.id, name: item.name, revision: item.revision });
	});
	if (new Set(references.map((item) => item.id)).size !== references.length
		|| new Set(references.map((item) => item.name)).size !== references.length) throw new TypeError("Duplicate skill reference.");
	return Object.freeze(references);
}

/** Removed mentions must not leave invisible skill selections attached to a draft. */
export function skillReferencesInText(references: readonly SkillReference[], text: string): readonly SkillReference[] {
	return references.filter((reference) => {
		const name = reference.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		return new RegExp(`(?:^|[^A-Za-z0-9_$])\\$${name}(?![A-Za-z0-9_:@.-])`, "u").test(text);
	});
}
