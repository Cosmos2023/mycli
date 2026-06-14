from __future__ import annotations

from mycli.services.skills import SkillRegistry


def render_skill_catalog(skill_registry: SkillRegistry) -> str:
    lines = ["Available skills:"]
    for name in skill_registry.list_names():
        metadata = skill_registry.get_metadata(name)
        if metadata is None:
            continue
        lines.append(
            f"- {metadata.name}: {metadata.description} "
            f"(file: {metadata.source_path})"
        )

    if len(lines) == 1:
        return ""

    lines.append("")
    lines.append(
        "Use the Skill tool with the exact skill name when one of these descriptions "
        "matches the current task. The listed file path identifies the source; do not "
        "infer or load skill bodies from this catalog."
    )
    return "\n".join(lines)
