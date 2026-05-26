from __future__ import annotations

from pathlib import Path

from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    CompactionRehydrationContext,
    FileRehydrationCandidate,
    InvokedSkillSnapshot,
    RehydratedFile,
    RehydratedSkill,
    RehydrationBudget,
)
from mycli.services.context.token_counter import TokenCounter

_STATE_FILE_PREFIXES = (
    ".mycli/",
    ".omx/",
    "docs/superpowers/plans/",
)


class CompactionRehydrationService:
    def __init__(
        self,
        *,
        workspace_root: Path,
        token_counter: TokenCounter,
        file_budget: RehydrationBudget,
        skill_budget: RehydrationBudget,
        max_files: int,
        max_skills: int,
    ) -> None:
        self._workspace_root = workspace_root.resolve()
        self._token_counter = token_counter
        self._file_budget = file_budget
        self._skill_budget = skill_budget
        self._max_files = max(0, max_files)
        self._max_skills = max(0, max_skills)

    def build(
        self,
        *,
        file_candidates: tuple[FileRehydrationCandidate, ...],
        invoked_skills: tuple[InvokedSkillSnapshot, ...],
        tail_messages: tuple[Message, ...],
    ) -> CompactionRehydrationContext:
        return CompactionRehydrationContext(
            files=self._build_files(file_candidates, tail_messages),
            invoked_skills=self._build_skills(invoked_skills),
        )

    def render(self, context: CompactionRehydrationContext) -> str:
        parts: list[str] = []
        if context.invoked_skills:
            parts.append(self._render_skills(context.invoked_skills))
        if context.files:
            parts.append(self._render_files(context.files))
        return "\n\n".join(parts)

    def _build_files(
        self,
        candidates: tuple[FileRehydrationCandidate, ...],
        tail_messages: tuple[Message, ...],
    ) -> tuple[RehydratedFile, ...]:
        tail_text = "\n".join(message.content for message in tail_messages if message.content)
        remaining_total = self._file_budget.max_total_tokens
        result: list[RehydratedFile] = []
        seen: set[str] = set()
        for candidate in self._ordered_candidates(candidates):
            if len(result) >= self._max_files or remaining_total <= 0:
                break
            resolved = self._resolve_workspace_file(candidate.path)
            if resolved is None:
                continue
            relative = str(resolved.relative_to(self._workspace_root))
            if relative in seen or self._is_state_file(relative):
                continue
            seen.add(relative)
            try:
                content = resolved.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if not content or content in tail_text:
                continue
            truncated_content, token_count, truncated = self._truncate(
                content=content,
                max_item_tokens=min(self._file_budget.max_item_tokens, remaining_total),
            )
            if not truncated_content:
                continue
            remaining_total -= token_count
            suffix = "\n[truncated]" if truncated else ""
            result.append(
                RehydratedFile(
                    path=relative,
                    content=f"{truncated_content}{suffix}",
                    token_count=token_count,
                    truncated=truncated,
                )
            )
        return tuple(result)

    def _build_skills(
        self,
        snapshots: tuple[InvokedSkillSnapshot, ...],
    ) -> tuple[RehydratedSkill, ...]:
        remaining_total = self._skill_budget.max_total_tokens
        result: list[RehydratedSkill] = []
        seen: set[str] = set()
        for snapshot in sorted(snapshots, key=lambda item: item.invoked_at, reverse=True):
            if len(result) >= self._max_skills or remaining_total <= 0:
                break
            if snapshot.name in seen:
                continue
            seen.add(snapshot.name)
            body = self._skill_body(snapshot)
            if not body:
                continue
            truncated_body, token_count, truncated = self._truncate(
                content=body,
                max_item_tokens=min(self._skill_budget.max_item_tokens, remaining_total),
            )
            if not truncated_body:
                continue
            remaining_total -= token_count
            suffix = "\n[truncated]" if truncated else ""
            result.append(
                RehydratedSkill(
                    name=snapshot.name,
                    description=snapshot.description,
                    source_path=snapshot.source_path,
                    body=f"{truncated_body}{suffix}",
                    token_count=token_count,
                    truncated=truncated,
                )
            )
        return tuple(result)

    def _ordered_candidates(
        self,
        candidates: tuple[FileRehydrationCandidate, ...],
    ) -> tuple[FileRehydrationCandidate, ...]:
        return tuple(
            sorted(
                candidates,
                key=lambda item: (0 if item.kind == "edit" else 1, -item.sequence),
            )
        )

    def _resolve_workspace_file(self, raw_path: str) -> Path | None:
        if not raw_path.strip():
            return None
        candidate = Path(raw_path)
        path = candidate if candidate.is_absolute() else self._workspace_root / candidate
        try:
            resolved = path.resolve()
            resolved.relative_to(self._workspace_root)
        except (OSError, ValueError):
            return None
        return resolved if resolved.is_file() else None

    def _is_state_file(self, relative_path: str) -> bool:
        normalized = relative_path.replace("\\", "/")
        return any(normalized.startswith(prefix) for prefix in _STATE_FILE_PREFIXES)

    def _skill_body(self, snapshot: InvokedSkillSnapshot) -> str:
        if snapshot.source_path:
            try:
                path = Path(snapshot.source_path)
                if path.is_file():
                    return path.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                pass
        return (snapshot.cached_body_excerpt or "").strip()

    def _truncate(self, *, content: str, max_item_tokens: int) -> tuple[str, int, bool]:
        if max_item_tokens <= 0:
            return "", 0, False
        token_count = self._token_counter.count(content)
        truncated = False
        while token_count > max_item_tokens and content:
            truncated = True
            content = content[: max(1, int(len(content) * 0.8))]
            token_count = self._token_counter.count(content)
        return content.rstrip(), token_count, truncated

    def _render_skills(self, skills: tuple[RehydratedSkill, ...]) -> str:
        blocks = [
            "[Invoked skills after compaction]",
            "Continue to follow these skill instructions.",
        ]
        for skill in skills:
            blocks.append(f"## {skill.name}\n{skill.body}")
        return "\n\n".join(blocks)

    def _render_files(self, files: tuple[RehydratedFile, ...]) -> str:
        blocks = [
            "[Compaction file rehydration]",
            "Recent file snapshots are current disk content. Re-read files if exact content matters.",
        ]
        for item in files:
            blocks.append(f"### {item.path}\n```text\n{item.content}\n```")
        return "\n\n".join(blocks)
