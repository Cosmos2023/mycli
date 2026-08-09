import { fileURLToPath } from "node:url";

export function builtinSkillRoot(): string {
	return fileURLToPath(new URL("../../assets/skills", import.meta.url));
}
