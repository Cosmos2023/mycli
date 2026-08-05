import type { SkillRegistry } from "./registry.ts";

export interface RenderSkillCatalogOptions {
	readonly maxChars?: number;
}

const DEFAULT_MAX_CATALOG_CHARS = 8_000;

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
		if ([...lines, line].join("\n").length > maxChars) break;
		lines.push(line);
	}
	const footer = "Use the Skill tool with an exact listed name when its description matches the task.";
	if ([...lines, "", footer].join("\n").length <= maxChars) lines.push("", footer);
	return lines.length > 1 ? lines.join("\n") : "";
}
