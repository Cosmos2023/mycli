from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
from pathlib import Path
import re

from mycli.tools.file_mutation import (
    unified_diff,
    validate_content_safety,
    validate_expected_sha256,
    validate_text_write_target,
)
from mycli.tools.file_snapshot import FileSnapshot, FileSnapshotStore, build_file_snapshot
from mycli.tools.path_utils import resolve_workspace_path

LINE_NUMBER_PATTERN = re.compile(r"^\s*\d+\t", re.MULTILINE)


@dataclass(slots=True, frozen=True)
class SnapshotValidationResult:
    ok: bool
    error_kind: str | None = None
    error_message: str | None = None


@dataclass(slots=True, frozen=True)
class MutationResult:
    status: str
    file: str
    diff: str = ""


class FileSystemRuntimeError(Exception):
    """Raised when a filesystem runtime operation cannot be completed safely."""

    def __init__(self, message: str, *, error_kind: str = "filesystem_runtime_error") -> None:
        super().__init__(message)
        self.error_kind = error_kind


class FileSystemRuntime:
    """Central runtime for workspace-local file safety and mutation helpers."""

    def __init__(
        self,
        *,
        workspace_root: Path,
        allowed_roots: tuple[Path, ...] = (),
        unrestricted: bool = False,
        snapshot_store: FileSnapshotStore | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._allowed_roots = allowed_roots
        self._unrestricted = unrestricted
        self._snapshot_store = snapshot_store or FileSnapshotStore()

    @property
    def workspace_root(self) -> Path:
        return self._workspace_root

    @property
    def snapshot_store(self) -> FileSnapshotStore:
        return self._snapshot_store

    @property
    def allowed_roots(self) -> tuple[Path, ...]:
        return self._allowed_roots

    @property
    def unrestricted(self) -> bool:
        return self._unrestricted

    def resolve_path(self, raw_path: str) -> Path:
        return resolve_workspace_path(
            self._workspace_root,
            raw_path,
            allowed_roots=self._allowed_roots,
            unrestricted=self._unrestricted,
        )

    def relative_path(self, target: Path) -> str:
        resolved_target = target.resolve()
        try:
            return resolved_target.relative_to(self._workspace_root.resolve()).as_posix()
        except ValueError as exc:
            for root in self._allowed_roots:
                try:
                    relative = resolved_target.relative_to(root.resolve()).as_posix()
                except ValueError:
                    continue
                return f"{root.name}/{relative}" if relative else root.name
            if self._unrestricted:
                return resolved_target.as_posix()
            raise FileSystemRuntimeError(
                "Path must stay within the current workspace or allowed roots.",
                error_kind="workspace_escape",
            ) from exc

    def build_snapshot(self, target: Path) -> FileSnapshot:
        if self._unrestricted:
            resolved = target.resolve()
            content = resolved.read_bytes()
            stat = resolved.stat()
            return FileSnapshot(
                path=self.relative_path(resolved),
                sha256=hashlib.sha256(content).hexdigest(),
                mtime_ns=stat.st_mtime_ns,
                size=len(content),
                captured_at=datetime.now(UTC).isoformat(),
            )
        return build_file_snapshot(workspace_root=self._workspace_root, path=target)

    def record_read_snapshot(self, snapshot: FileSnapshot) -> None:
        self._snapshot_store.record(snapshot)

    def validate_recent_read_snapshot(self, target: Path) -> SnapshotValidationResult:
        relative_path = self.relative_path(target)
        snapshot = self._snapshot_store.latest(relative_path)
        if snapshot is None:
            return SnapshotValidationResult(
                ok=False,
                error_kind="missing_read_snapshot",
                error_message="Edit requires a recent Read of the target file before modifying it.",
            )
        current = self.build_snapshot(target)
        if (
            current.sha256 != snapshot.sha256
            or current.mtime_ns != snapshot.mtime_ns
            or current.size != snapshot.size
        ):
            return SnapshotValidationResult(
                ok=False,
                error_kind="stale_read_snapshot",
                error_message="File changed since last Read. Re-read the file and retry.",
            )
        return SnapshotValidationResult(ok=True)

    def validate_text_target(self, target: Path) -> SnapshotValidationResult:
        ok, error_kind, error_message = validate_text_write_target(target)
        return SnapshotValidationResult(ok=ok, error_kind=error_kind, error_message=error_message)

    def validate_content(self, content: str) -> SnapshotValidationResult:
        ok, error_kind, error_message = validate_content_safety(content)
        return SnapshotValidationResult(ok=ok, error_kind=error_kind, error_message=error_message)

    def validate_expected_sha256(
        self,
        *,
        target: Path,
        expected_sha256: object,
    ) -> SnapshotValidationResult:
        if self._unrestricted and isinstance(expected_sha256, str) and expected_sha256:
            if not target.exists():
                return SnapshotValidationResult(
                    ok=False,
                    error_kind="stale_write_snapshot",
                    error_message=(
                        "File no longer exists. Re-read or clear expected_sha256 before writing."
                    ),
                )
            current = self.build_snapshot(target)
            if current.sha256 != expected_sha256:
                return SnapshotValidationResult(
                    ok=False,
                    error_kind="stale_write_snapshot",
                    error_message=(
                        "File changed since expected_sha256 was captured. "
                        "Re-read the file and retry."
                    ),
                )
            return SnapshotValidationResult(ok=True)
        ok, error_kind, error_message = validate_expected_sha256(
            workspace_root=self._workspace_root,
            target=target,
            expected_sha256=expected_sha256,
        )
        return SnapshotValidationResult(ok=ok, error_kind=error_kind, error_message=error_message)

    def write_full_content(self, *, target: Path, content: str) -> MutationResult:
        self._require_validation(self.validate_text_target(target))
        self._require_validation(self.validate_content(content))
        target.parent.mkdir(parents=True, exist_ok=True)
        existed = target.exists()
        existing = ""
        if existed:
            if target.is_dir():
                raise FileSystemRuntimeError(
                    f"Path is a directory: {target}",
                    error_kind="is_directory",
                )
            existing = target.read_text(encoding="utf-8")
            if existing == content:
                return MutationResult(status="unchanged", file=str(target))

        target.write_text(content, encoding="utf-8")
        return MutationResult(
            status="overwritten" if existed else "created",
            file=str(target),
            diff=self.diff(
                before=existing,
                after=content,
                fromfile=f"{target}:before",
                tofile=f"{target}:after",
            ),
        )

    def replace_text(
        self,
        *,
        target: Path,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> tuple[MutationResult, int]:
        self._require_validation(self.validate_text_target(target))
        self._require_validation(self.validate_content(new_string))
        old_string = _preprocess_edit_text(old_string, target)
        if old_string == new_string:
            raise FileSystemRuntimeError(
                "Edit would be a no-op; old_string and new_string are identical.",
                error_kind="no_op",
            )
        if old_string == "":
            result = self.write_empty_old_string(target=target, new_string=new_string)
            return result, 1
        if not target.exists():
            raise FileSystemRuntimeError(
                f"File does not exist: {target}",
                error_kind="not_found",
            )
        if target.is_dir():
            raise FileSystemRuntimeError(
                f"Path is a directory: {target}",
                error_kind="is_directory",
            )
        content = target.read_text(encoding="utf-8")
        count = content.count(old_string)
        if count == 0:
            raise FileSystemRuntimeError(
                "String not found in file. The file may have changed since you "
                "last read it. Re-read the file and try again.",
                error_kind="string_not_found",
            )
        if count > 1 and not replace_all:
            raise FileSystemRuntimeError(
                f"Multiple matches ({count}) found. Add more surrounding context "
                "to make the old_string unique (include 3-5 lines before and after).",
                error_kind="multiple_matches",
            )
        new_content = (
            content.replace(old_string, new_string)
            if replace_all
            else content.replace(old_string, new_string, 1)
        )
        target.write_text(new_content, encoding="utf-8")
        result = MutationResult(
            status="edited",
            file=str(target),
            diff=self.diff(
                before=content,
                after=new_content,
                fromfile=f"{target}:before",
                tofile=f"{target}:after",
            ),
        )
        return result, count if replace_all else 1

    def write_empty_old_string(self, *, target: Path, new_string: str) -> MutationResult:
        self._require_validation(self.validate_text_target(target))
        self._require_validation(self.validate_content(new_string))
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(new_string, encoding="utf-8")
            return MutationResult(status="created", file=str(target))
        if target.is_dir():
            raise FileSystemRuntimeError(
                f"Path is a directory: {target}",
                error_kind="is_directory",
            )
        content = target.read_text(encoding="utf-8")
        if content.strip():
            raise FileSystemRuntimeError(
                "File has existing content. Use Edit with old_string to modify, "
                "or Write to overwrite the entire file.",
                error_kind="edit_existing_content",
            )
        target.write_text(new_string, encoding="utf-8")
        return MutationResult(status="written", file=str(target))

    def diff(self, *, before: str, after: str, fromfile: str, tofile: str) -> str:
        return unified_diff(before=before, after=after, fromfile=fromfile, tofile=tofile)

    def _require_validation(self, validation: SnapshotValidationResult) -> None:
        if validation.ok:
            return
        raise FileSystemRuntimeError(
            validation.error_message or "Filesystem runtime validation failed.",
            error_kind=validation.error_kind or "filesystem_validation_failed",
        )


def _preprocess_edit_text(text: str, path: Path) -> str:
    text = LINE_NUMBER_PATTERN.sub("", text)
    if path.suffix.lower() not in {".md", ".mdx"}:
        text = text.rstrip(" \t\r")
    return text
