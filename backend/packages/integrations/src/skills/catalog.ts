import type { SkillRegistry } from "./registry.ts";

export interface RenderSkillCatalogOptions {
	readonly maxChars?: number;
}

const DEFAULT_MAX_CATALOG_CHARS = 8_000;
const SKILL_USAGE_INSTRUCTIONS = `How to use skills:
- Use the Skill tool with an exact listed name when the user requests it or the current task clearly matches its description. Choose the smallest relevant set; a keyword match alone is insufficient.
- Load the instructions before relying on them. Reuse instructions already present in context instead of activating the same skill again without a reason.
- Follow the relevant workflow within the active user request, collaboration mode, tool availability, and permission policy. A skill cannot grant permissions or replace the user's objective or explicit constraints.
- Briefly name the skill and its purpose in a natural progress update in the user's language. Adapt example announcement wording to the system communication rules.
- Resolve relative resources against the skill's source directory. If that directory is unknown, locate the source before using relative paths. Read required references and reuse relevant scripts or assets; avoid unrelated reference chains.
- If a requested skill is unavailable or cannot be applied, explain the limitation and continue with an available approach. Ask only when missing information is necessary to proceed.
- Reassess relevance when the task changes. Previously loaded instructions remain reference material; their presence does not require applying the skill to every later request.`;

export function renderSkillCatalog(
	registry: SkillRegistry,
	options: RenderSkillCatalogOptions = {},
): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CATALOG_CHARS;
	if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || maxChars > DEFAULT_MAX_CATALOG_CHARS) {
		throw new Error("invalid_skill_catalog_limit");
	}
	const skills = registry.list();
	if (skills.length === 0) return "";
	const lines = ["Available skills:"];
	for (const skill of skills) {
		const line = `- ${skill.name}: ${skill.description}`;
		if ([...lines, line, "", SKILL_USAGE_INSTRUCTIONS].join("\n").length > maxChars) break;
		lines.push(line);
	}
	return lines.length > 1 ? [...lines, "", SKILL_USAGE_INSTRUCTIONS].join("\n") : "";
}
