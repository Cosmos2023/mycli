from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

from mycli.domain.memory import MemoryKind, MemoryRecord
from mycli.domain.session_store import SessionStore
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.memory.extraction import extract_explicit_memory_request
from mycli.memory.memdir import (
    ENTRYPOINT_NAME,
    FileMemory,
    ensure_memory_dir,
    entrypoint_path,
    forget_memory,
    format_memory_manifest,
    load_entrypoint,
    memory_dir_for,
    scan_memory_files,
    select_relevant_memories,
    write_memory_file,
)
from mycli.memory.selector import FileMemorySelector

_TOKEN_PATTERN = re.compile(r"[a-z0-9_./-]+")


class MemoryService:
    def __init__(
        self,
        home_dir: Path,
        workspace_root: Path,
        session_store: SessionStore | None = None,
        file_memory_selector: FileMemorySelector | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._session_store = session_store or SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")
        self._file_memory_dir = memory_dir_for(home_dir, workspace_root)
        self._file_memory_selector = file_memory_selector
        ensure_memory_dir(self._file_memory_dir)

    def append_session_summary(self, session_id: str, summary: str) -> None:
        self._session_store.append_session_summary(
            session_id=session_id,
            workspace_root=self._workspace_root,
            thread_id=session_id,
            summary=summary,
        )

    def load_session_summaries(self, session_id: str) -> list[str]:
        return self._session_store.load_session_summaries(session_id)

    def file_memory_dir(self) -> Path:
        ensure_memory_dir(self._file_memory_dir)
        return self._file_memory_dir

    def file_memory_entrypoint_path(self) -> Path:
        return entrypoint_path(self.file_memory_dir())

    def inspect_file_memory(self) -> tuple[str, ...]:
        memory_dir = self.file_memory_dir()
        memories = scan_memory_files(memory_dir)
        entrypoint = load_entrypoint(memory_dir)
        lines = [
            f"path={memory_dir}",
            f"entrypoint={self.file_memory_entrypoint_path()}",
            f"entrypoint_lines={entrypoint.line_count} entrypoint_bytes={entrypoint.byte_count}",
            f"files={len(memories)}",
        ]
        manifest = format_memory_manifest(memories[:10])
        if manifest:
            lines.extend(manifest.splitlines())
        return tuple(lines)

    def add_file_memory(
        self,
        *,
        kind: MemoryKind,
        name: str,
        description: str,
        content: str,
    ) -> FileMemory:
        return write_memory_file(
            self.file_memory_dir(),
            kind=kind,
            name=name,
            description=description,
            content=content,
        )

    def search_file_memories(self, query: str, *, limit: int = 5) -> tuple[FileMemory, ...]:
        return self._select_file_memories(query, limit=limit)

    def forget_file_memory(self, query: str) -> tuple[FileMemory, ...]:
        return forget_memory(self.file_memory_dir(), query)

    def extract_explicit_memory(self, user_message: str) -> tuple[str, ...]:
        extraction = extract_explicit_memory_request(user_message)
        if extraction is None:
            return ()
        if extraction.action == "forget":
            removed = self.forget_file_memory(extraction.content)
            if not removed:
                return ("memory_forget_no_match",)
            return tuple(f"memory_forgot:{memory.filename}" for memory in removed)
        if extraction.action != "remember":
            return ()
        memory = self.add_file_memory(
            kind=extraction.kind,
            name=extraction.name,
            description=extraction.description,
            content=extraction.content,
        )
        return (f"memory_saved:{memory.filename}",)

    def _session_summary_records(self, session_id: str | None) -> tuple[MemoryRecord, ...]:
        if session_id is None:
            return ()
        return tuple(
            MemoryRecord(
                kind=MemoryKind.SESSION_SUMMARY,
                key="recent",
                value=value,
            )
            for value in self.load_session_summaries(session_id)
        )

    def collect_runtime_context(
        self,
        *,
        user_message: str,
        session_id: str,
        enabled: bool = True,
    ) -> tuple[MemoryRecord, ...]:
        if not enabled:
            return ()
        session_summary_records = self._session_summary_records(session_id)
        file_memory_records = self._file_memory_runtime_records(user_message)
        return self._deduplicate(
            (
                *file_memory_records,
                *session_summary_records,
            )
        )

    def _file_memory_runtime_records(self, user_message: str) -> tuple[MemoryRecord, ...]:
        lowered = user_message.lower()
        if "ignore memory" in lowered or "do not use memory" in lowered or "not use memory" in lowered:
            return ()
        memory_dir = self.file_memory_dir()
        records: list[MemoryRecord] = [
            MemoryRecord(
                kind=MemoryKind.REFERENCE,
                key="memory_system",
                value=self._file_memory_guidance(memory_dir),
                tags=("file-memory", "claude-style"),
            )
        ]
        entrypoint = load_entrypoint(memory_dir)
        if entrypoint.content:
            records.append(
                MemoryRecord(
                    kind=MemoryKind.REFERENCE,
                    key=ENTRYPOINT_NAME,
                    value=entrypoint.content,
                    tags=("file-memory", "index"),
                )
            )
        for memory in self._select_file_memories(user_message, limit=5):
            kind = memory.kind or MemoryKind.REFERENCE
            description = f"{memory.description}\n\n" if memory.description else ""
            records.append(
                MemoryRecord(
                    kind=kind,
                    key=f"{memory.filename}",
                    value=(
                        f"{description}{memory.content}\n\n"
                        f"Memory file: {memory.path}"
                    ).strip(),
                    tags=("file-memory", memory.filename),
                )
            )
        return tuple(records)

    def _select_file_memories(
        self,
        query: str,
        *,
        limit: int,
    ) -> tuple[FileMemory, ...]:
        memories = scan_memory_files(self.file_memory_dir())
        if self._file_memory_selector is not None:
            try:
                selected = self._file_memory_selector.select(
                    query,
                    memories,
                    limit=limit,
                )
            except Exception:
                selected = ()
            by_filename = {memory.filename: memory for memory in memories}
            selected_memories = tuple(
                by_filename[filename]
                for filename in selected
                if filename in by_filename
            )
            if selected_memories:
                return selected_memories[:limit]
        return select_relevant_memories(query, memories, limit=limit)

    def _file_memory_guidance(self, memory_dir: Path) -> str:
        return "\n".join(
            [
                f"You have persistent file-based memory at `{memory_dir}`.",
                "This directory already exists and is an allowed filesystem root for Read, Write, Edit, LS, Grep, and Glob.",
                "Write to it directly; do not run mkdir or check for its existence first.",
                f"`{ENTRYPOINT_NAME}` is an index, not a memory body; keep each entry one line.",
                f"Never write memory content directly into `{ENTRYPOINT_NAME}`.",
                "Memory files are Markdown files with frontmatter: name, description, type.",
                "Allowed memory types: user, feedback, project, reference.",
                "Save explicit user requests to remember; remove relevant files when asked to forget.",
                "Do not save derivable code structure, git history, fix recipes, or ephemeral task state.",
                "Treat memory as possibly stale; verify file/function/flag claims against current state.",
                "If the user says to ignore memory, proceed as if memory were empty.",
            ]
        )

    def _deduplicate(self, records: Iterable[MemoryRecord]) -> tuple[MemoryRecord, ...]:
        seen: set[tuple[MemoryKind, str, str]] = set()
        deduplicated: list[MemoryRecord] = []
        for record in records:
            identity = (
                record.kind,
                self._normalize_text(record.key),
                self._normalize_text(record.value),
            )
            if identity in seen:
                continue
            seen.add(identity)
            deduplicated.append(record)
        return tuple(deduplicated)

    def _normalize_text(self, text: str) -> str:
        return " ".join(_TOKEN_PATTERN.findall(text.lower()))
