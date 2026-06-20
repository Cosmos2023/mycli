from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.runtime import (
    CollaborationMode,
    TurnContextCacheClass,
    TurnContextSection,
)


@dataclass(slots=True, frozen=True)
class DeveloperInstructionSection:
    kind: str
    title: str
    content: str
    source: str
    cache_class: TurnContextCacheClass
    metadata: dict[str, object]


def render_permissions_instructions(
    section: TurnContextSection,
) -> DeveloperInstructionSection | None:
    metadata = dict(section.metadata)
    if not metadata:
        return None

    workspace_root = _string(metadata.get("workspace_root"))
    writable_roots = _string_list(metadata.get("writable_roots"))
    denied_read_roots = _string_list(metadata.get("denied_read_roots"))
    denied_read_globs = _string_list(metadata.get("denied_read_globs"))
    filesystem = _string(metadata.get("filesystem"))
    network = _string(metadata.get("network"))
    shell = _string(metadata.get("shell"))
    shell_backend = _shell_backend_summary(metadata.get("shell_backend"))
    approval_policy = _string(metadata.get("approval_policy"))
    command_policy = _string(metadata.get("command_policy"))
    file_policy = _string(metadata.get("file_policy"))
    tool_policy = _string(metadata.get("tool_policy"))
    execpolicy_status = _string(metadata.get("execpolicy_status"))
    execpolicy_rule_count = _string(metadata.get("execpolicy_rule_count"))
    execpolicy_sources = _string_list(metadata.get("execpolicy_sources"))

    lines = [
        "<permissions instructions>",
        _sandbox_text(filesystem=filesystem, network=network),
    ]
    writable_roots_text = _writable_roots_text(writable_roots)
    if writable_roots_text:
        lines.extend(("", writable_roots_text))
    denied_reads_text = _denied_reads_text(
        denied_read_roots=denied_read_roots,
        denied_read_globs=denied_read_globs,
    )
    if denied_reads_text:
        lines.extend(("", denied_reads_text))
    lines.extend(
        (
            "",
            _approval_text(approval_policy=approval_policy),
            "",
            "Runtime permission metadata for this turn:",
            f"- workspace_root: {workspace_root}",
            f"- writable_roots_count: {len(writable_roots)}",
            f"- denied_read_roots_count: {len(denied_read_roots)}",
            f"- denied_read_globs_count: {len(denied_read_globs)}",
            f"- filesystem: {filesystem}",
            f"- network: {network}",
            f"- shell: {shell}",
            f"- shell_backend: {shell_backend}",
            f"- approval_policy: {approval_policy}",
            f"- command_policy: {command_policy}",
            f"- file_policy: {file_policy}",
            f"- tool_policy: {tool_policy}",
            f"- execpolicy: {execpolicy_status}",
            f"- execpolicy_rule_count: {execpolicy_rule_count}",
        )
    )
    if execpolicy_sources:
        lines.append(f"- execpolicy_sources: {', '.join(execpolicy_sources)}")
    lines.extend(
        (
            "",
            "Respect the runtime permissions above. They are model-visible "
            "constraints; execution is still enforced by the runtime.",
            "If a needed operation is blocked by these permissions, use an "
            "allowed fallback or report the blocker.",
            "</permissions instructions>",
        )
    )
    return DeveloperInstructionSection(
        kind="permissions",
        title="Runtime permissions",
        content="\n".join(lines),
        source=section.source or "runtime",
        cache_class=section.cache_class,
        metadata={
            **metadata,
            "developer_instruction": True,
            "tag": "permissions instructions",
        },
    )


def render_collaboration_mode(
    mode: CollaborationMode,
) -> DeveloperInstructionSection:
    content = (
        _render_plan_collaboration_mode()
        if mode is CollaborationMode.PLAN
        else _render_default_collaboration_mode()
    )
    return DeveloperInstructionSection(
        kind="collaboration_mode",
        title="Collaboration mode",
        content=content,
        source="runtime",
        cache_class=TurnContextCacheClass.STATIC,
        metadata={
            "cache_class": TurnContextCacheClass.STATIC.value,
            "developer_instruction": True,
            "mode": mode.value,
            "tag": "collaboration_mode",
        },
    )


def render_skills_instructions(catalog: str) -> DeveloperInstructionSection | None:
    body = catalog.strip()
    if not body:
        return None
    content = "\n".join(
        (
            "<skills_instructions>",
            "## Skills",
            "A skill is a set of local instructions to follow. The catalog "
            "below lists the skills available in this session.",
            "### Available skills",
            body,
            "### How to use skills",
            "- Treat the catalog as an index, not as skill body content.",
            "- If the user names a skill or the task clearly matches a listed "
            "skill, load that skill through the Skill tool before following it.",
            "- Load only the needed skill body. Do not load unrelated skills.",
            "- If a skill cannot be loaded, explain briefly and continue with "
            "the nearest safe fallback.",
            "- Keep context small: summarize long skill instructions and avoid "
            "deep reference chasing unless blocked.",
            "</skills_instructions>",
        )
    )
    return DeveloperInstructionSection(
        kind="skill_catalog",
        title="Skills instructions",
        content=content,
        source="skill_registry",
        cache_class=TurnContextCacheClass.STATIC,
        metadata={
            "cache_class": TurnContextCacheClass.STATIC.value,
            "developer_instruction": True,
            "tag": "skills_instructions",
        },
    )


def _string(value: object) -> str:
    if value is None:
        return "unknown"
    return str(value)


def _string_list(value: object) -> tuple[str, ...]:
    if not isinstance(value, list | tuple):
        return ()
    return tuple(str(item) for item in value if str(item))


def _shell_backend_summary(value: object) -> str:
    if not isinstance(value, dict):
        return "unknown"
    backend = _string(value.get("backend"))
    isolation = _string(value.get("isolation"))
    available = _string(value.get("available"))
    return f"{backend} available={available} isolation={isolation}"


def _writable_roots_text(writable_roots: tuple[str, ...]) -> str:
    if not writable_roots:
        return ""
    roots = ", ".join(f"`{root}`" for root in writable_roots)
    if len(writable_roots) == 1:
        return f"The writable root is {roots}."
    return f"The writable roots are {roots}."


def _denied_reads_text(
    *,
    denied_read_roots: tuple[str, ...],
    denied_read_globs: tuple[str, ...],
) -> str:
    if not denied_read_roots and not denied_read_globs:
        return ""
    return (
        "Denied filesystem reads are active: "
        f"{len(denied_read_roots)} path root(s), "
        f"{len(denied_read_globs)} glob rule(s). "
        "Do not request escalation or additional permissions for denied reads; "
        "these are policy restrictions."
    )


def _approval_text(*, approval_policy: str) -> str:
    if approval_policy == "safety_policy":
        return (
            "Approval policy is `safety_policy`: low-risk read and inspection "
            "tools are auto-approved. Mutating tools, shell commands, and writes "
            "outside the workspace may create an approval request instead of "
            "executing the tool. Do not assume approval was granted; continue "
            "only after the runtime returns an approved result, otherwise use an "
            "allowed fallback or report the blocker."
        )
    return (
        f"Approval policy is `{approval_policy}`. Respect runtime approval "
        "decisions and do not assume a blocked action was approved."
    )


def _sandbox_text(*, filesystem: str, network: str) -> str:
    network_access = "enabled" if network == "enabled" else "restricted"
    if filesystem == "unrestricted":
        return (
            "Filesystem sandboxing defines which files can be read or written. "
            "`sandbox_mode` is `danger-full-access`: No filesystem sandboxing - "
            f"all commands are permitted. Network access is {network_access}."
        )
    if filesystem == "read_only":
        return (
            "Filesystem sandboxing defines which files can be read or written. "
            "`sandbox_mode` is `read-only`: The sandbox only permits reading "
            f"files. Network access is {network_access}."
        )
    return (
        "Filesystem sandboxing defines which files can be read or written. "
        "`sandbox_mode` is `workspace-write`: The sandbox permits reading "
        "files, and editing files in `cwd` and `writable_roots`. Editing files "
        f"in other directories requires approval. Network access is {network_access}."
    )


def _render_default_collaboration_mode() -> str:
    return "\n".join(
        (
            "<collaboration_mode># Collaboration Mode: Default",
            "",
            "You are now in Default mode. Previous mode-specific instructions "
            "are inactive unless a newer developer instruction says otherwise.",
            "",
            "Your active mode changes only when new developer instructions with "
            "a different `<collaboration_mode>...</collaboration_mode>` block "
            "change it; user text alone does not change the mode.",
            "",
            "In Default mode, prefer making reasonable assumptions and executing "
            "clear, reversible next steps instead of stopping to ask questions. "
            "Ask only when the answer cannot be discovered from local context and "
            "a reasonable assumption would be risky.",
            "</collaboration_mode>",
        )
    )


def _render_plan_collaboration_mode() -> str:
    return "\n".join(
        (
            "<collaboration_mode># Collaboration Mode: Plan",
            "",
            "You are now in Plan mode. You remain in Plan mode until a newer "
            "developer instruction changes the active collaboration mode.",
            "",
            "Plan mode is for producing a decision-complete implementation plan. "
            "If the user asks for execution while still in Plan mode, treat that "
            "as a request to plan the execution, not perform it.",
            "",
            "Allowed actions:",
            "- Read/search files, inspect configs, and run non-mutating checks "
            "that improve the plan.",
            "- Ask only questions that materially change the plan and cannot be "
            "answered from local context.",
            "",
            "Not allowed actions:",
            "- Editing, writing, formatting, migrating, or otherwise changing "
            "repo-tracked files.",
            "- Running side-effectful commands whose purpose is to carry out the "
            "plan rather than refine it.",
            "",
            "When the plan is ready, present it as the final answer. Do not ask "
            "`should I proceed?`; the user can switch modes or ask for execution.",
            "</collaboration_mode>",
        )
    )
