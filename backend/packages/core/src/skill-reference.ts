const SKILL_REFERENCE = /^(?:[a-z0-9][a-z0-9._-]{0,63}(?:@[a-z0-9][a-z0-9._-]{0,63})?:)?[a-z0-9][a-z0-9_-]{0,63}$/u;

export function isSkillReferenceName(value: unknown): value is string {
	return typeof value === "string" && SKILL_REFERENCE.test(value);
}
