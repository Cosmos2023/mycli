from __future__ import annotations

import re
from collections.abc import Iterable
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from mycli.domain.memory import MemoryKind

ENTRYPOINT_NAME = "MEMORY.md"
MAX_ENTRYPOINT_LINES = 200
MAX_ENTRYPOINT_BYTES = 25_000
MAX_MEMORY_FILES = 200
FRONTMATTER_MAX_LINES = 30
VALID_FILE_MEMORY_KINDS = (
    MemoryKind.USER,
    MemoryKind.FEEDBACK,
    MemoryKind.PROJECT,
    MemoryKind.REFERENCE,
)

_SLUG_PATTERN = re.compile(r"[^a-zA-Z0-9_.-]+")
_TOKEN_PATTERN = re.compile(r"[a-z0-9_./-]+")


@dataclass(slots=True, frozen=True)
class EntrypointContent:
    content: str
    line_count: int
    byte_count: int
    was_line_truncated: bool
    was_byte_truncated: bool


@dataclass(slots=True, frozen=True)
class FileMemory:
    filename: str
    path: Path
    mtime: float
    kind: MemoryKind | None
    name: str
    description: str
    content: str


def memory_dir_for(home_dir: Path, workspace_root: Path) -> Path:
    """Return the Claude-style project memory directory for this workspace."""
    return home_dir / ".mycli" / "projects" / _sanitize_project_key(workspace_root) / "memory"


def ensure_memory_dir(memory_dir: Path) -> None:
    memory_dir.mkdir(parents=True, exist_ok=True)


def entrypoint_path(memory_dir: Path) -> Path:
    return memory_dir / ENTRYPOINT_NAME


def truncate_entrypoint_content(raw: str) -> EntrypointContent:
    trimmed = raw.strip()
    lines = trimmed.splitlines()
    line_count = len(lines)
    byte_count = len(trimmed.encode("utf-8"))
    was_line_truncated = line_count > MAX_ENTRYPOINT_LINES
    was_byte_truncated = byte_count > MAX_ENTRYPOINT_BYTES
    if not was_line_truncated and not was_byte_truncated:
        return EntrypointContent(
            content=trimmed,
            line_count=line_count,
            byte_count=byte_count,
            was_line_truncated=False,
            was_byte_truncated=False,
        )

    truncated = "\n".join(lines[:MAX_ENTRYPOINT_LINES]) if was_line_truncated else trimmed
    while len(truncated.encode("utf-8")) > MAX_ENTRYPOINT_BYTES:
        cut_at = truncated.rfind("\n")
        if cut_at <= 0:
            encoded = truncated.encode("utf-8")[:MAX_ENTRYPOINT_BYTES]
            truncated = encoded.decode("utf-8", errors="ignore")
            break
        truncated = truncated[:cut_at]
    reason = []
    if was_line_truncated:
        reason.append(f"{line_count} lines")
    if was_byte_truncated:
        reason.append(f"{byte_count} bytes")
    content = (
        f"{truncated}\n\n"
        f"> WARNING: {ENTRYPOINT_NAME} is {' and '.join(reason)}. "
        "Only part of it was loaded. Keep index entries concise and move detail into topic files."
    )
    return EntrypointContent(
        content=content,
        line_count=line_count,
        byte_count=byte_count,
        was_line_truncated=was_line_truncated,
        was_byte_truncated=was_byte_truncated,
    )


def load_entrypoint(memory_dir: Path) -> EntrypointContent:
    path = entrypoint_path(memory_dir)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return EntrypointContent("", 0, 0, False, False)
    return truncate_entrypoint_content(raw)


def scan_memory_files(memory_dir: Path) -> tuple[FileMemory, ...]:
    try:
        paths = sorted(
            (
                path
                for path in memory_dir.rglob("*.md")
                if path.is_file() and path.name != ENTRYPOINT_NAME
            ),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )[:MAX_MEMORY_FILES]
    except OSError:
        return ()

    memories: list[FileMemory] = []
    for path in paths:
        try:
            raw = path.read_text(encoding="utf-8")
            stat = path.stat()
        except OSError:
            continue
        header = _parse_frontmatter("\n".join(raw.splitlines()[:FRONTMATTER_MAX_LINES]))
        body = _strip_frontmatter(raw)
        kind = _parse_memory_kind(header.get("type", ""))
        memories.append(
            FileMemory(
                filename=path.relative_to(memory_dir).as_posix(),
                path=path,
                mtime=stat.st_mtime,
                kind=kind,
                name=header.get("name", path.stem).strip() or path.stem,
                description=header.get("description", "").strip(),
                content=body.strip(),
            )
        )
    return tuple(memories)


def format_memory_manifest(memories: Iterable[FileMemory]) -> str:
    lines: list[str] = []
    for memory in memories:
        tag = f"[{memory.kind.value}] " if memory.kind is not None else ""
        timestamp = datetime.fromtimestamp(memory.mtime, UTC).isoformat()
        suffix = f": {memory.description}" if memory.description else ""
        lines.append(f"- {tag}{memory.filename} ({timestamp}){suffix}")
    return "\n".join(lines)


def select_relevant_memories(
    query: str,
    memories: Iterable[FileMemory],
    *,
    limit: int = 5,
) -> tuple[FileMemory, ...]:
    query_tokens = _tokens(query)
    scored: list[tuple[float, float, FileMemory]] = []
    for memory in memories:
        if not query_tokens:
            score = 0.1 if memory.kind in {MemoryKind.USER, MemoryKind.FEEDBACK} else 0.0
        else:
            score = _score_memory(query_tokens, memory)
        if score > 0:
            scored.append((score, memory.mtime, memory))
    scored.sort(key=lambda item: (-item[0], -item[1], item[2].filename))
    return tuple(memory for _, _, memory in scored[:limit])


def write_memory_file(
    memory_dir: Path,
    *,
    kind: MemoryKind,
    name: str,
    description: str,
    content: str,
) -> FileMemory:
    if kind not in VALID_FILE_MEMORY_KINDS:
        allowed = ", ".join(memory_kind.value for memory_kind in VALID_FILE_MEMORY_KINDS)
        raise ValueError(f"unsupported memory type: {kind.value}; allowed={allowed}")
    ensure_memory_dir(memory_dir)
    filename = unique_memory_filename(memory_dir, name)
    path = memory_dir / filename
    rendered = "\n".join(
        [
            "---",
            f"name: {_frontmatter_scalar(name)}",
            f"description: {_frontmatter_scalar(description)}",
            f"type: {kind.value}",
            "---",
            "",
            content.strip(),
            "",
        ]
    )
    path.write_text(rendered, encoding="utf-8")
    update_entrypoint(memory_dir, filename=filename, title=name, description=description)
    stat = path.stat()
    return FileMemory(
        filename=filename,
        path=path,
        mtime=stat.st_mtime,
        kind=kind,
        name=name.strip(),
        description=description.strip(),
        content=content.strip(),
    )


def unique_memory_filename(memory_dir: Path, name: str) -> str:
    stem = _sanitize_filename(name)
    candidate = f"{stem}.md"
    index = 2
    while (memory_dir / candidate).exists():
        candidate = f"{stem}-{index}.md"
        index += 1
    return candidate


def update_entrypoint(
    memory_dir: Path,
    *,
    filename: str,
    title: str,
    description: str,
) -> None:
    ensure_memory_dir(memory_dir)
    path = entrypoint_path(memory_dir)
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        existing = ""
    lines = [line for line in existing.splitlines() if f"]({filename})" not in line]
    hook = description.strip() or title.strip()
    lines.append(f"- [{title.strip() or filename}]({filename}) - {hook}")
    path.write_text("\n".join(line for line in lines if line.strip()) + "\n", encoding="utf-8")


def forget_memory(memory_dir: Path, query: str) -> tuple[FileMemory, ...]:
    needle = query.strip()
    if not needle:
        return ()
    memories = scan_memory_files(memory_dir)
    exact = tuple(
        memory
        for memory in memories
        if memory.filename == needle
        or memory.name == needle
        or memory.path.name == needle
    )
    selected = exact or select_relevant_memories(needle, memories, limit=5)
    removed: list[FileMemory] = []
    for memory in selected:
        try:
            with suppress(FileNotFoundError):
                memory.path.unlink()
        except OSError:
            continue
        removed.append(memory)
    if removed:
        _remove_entrypoint_lines(memory_dir, {memory.filename for memory in removed})
    return tuple(removed)


def _remove_entrypoint_lines(memory_dir: Path, filenames: set[str]) -> None:
    path = entrypoint_path(memory_dir)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    kept = [
        line
        for line in lines
        if not any(f"]({filename})" in line for filename in filenames)
    ]
    path.write_text("\n".join(kept).strip() + ("\n" if kept else ""), encoding="utf-8")


def _parse_frontmatter(raw: str) -> dict[str, str]:
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    data: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def _strip_frontmatter(raw: str) -> str:
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return raw
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "\n".join(lines[index + 1 :])
    return raw


def _parse_memory_kind(raw: str) -> MemoryKind | None:
    try:
        kind = MemoryKind(raw.strip())
    except ValueError:
        return None
    if kind not in VALID_FILE_MEMORY_KINDS:
        return None
    return kind


def _score_memory(query_tokens: frozenset[str], memory: FileMemory) -> float:
    filename_tokens = _tokens(memory.filename)
    name_tokens = _tokens(memory.name)
    description_tokens = _tokens(memory.description)
    content_tokens = _tokens(memory.content)
    weighted = (
        3.0 * len(_matches(query_tokens, filename_tokens))
        + 3.0 * len(_matches(query_tokens, name_tokens))
        + 2.0 * len(_matches(query_tokens, description_tokens))
        + len(_matches(query_tokens, content_tokens))
    )
    all_tokens = filename_tokens | name_tokens | description_tokens | content_tokens
    if weighted == 0 or not all_tokens:
        return 0
    overlap = _matches(query_tokens, all_tokens)
    return weighted + (len(overlap) / max(len(query_tokens), 1))


def _matches(query_tokens: frozenset[str], field_tokens: frozenset[str]) -> frozenset[str]:
    return frozenset(
        query_token
        for query_token in query_tokens
        if any(
            query_token == field_token
            or query_token in field_token
            or field_token in query_token
            for field_token in field_tokens
        )
    )


def _tokens(text: str) -> frozenset[str]:
    return frozenset(_TOKEN_PATTERN.findall(text.lower()))


def _sanitize_project_key(workspace_root: Path) -> str:
    resolved = str(workspace_root.expanduser().resolve())
    return _SLUG_PATTERN.sub("-", resolved.strip("/")).strip("-") or "default"


def _sanitize_filename(name: str) -> str:
    slug = _SLUG_PATTERN.sub("_", name.strip().lower()).strip("._-")
    return slug[:80] or "memory"


def _frontmatter_scalar(value: str) -> str:
    return value.strip().replace("\n", " ")
