from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import tempfile
from typing import Literal

from mycli.config.file_permissions import harden_private_path
from mycli.domain.runtime import (
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicySource,
)
from mycli.services.execpolicy import ExecPolicyLoader
from mycli.services.execpolicy_lock import execpolicy_file_lock


LockFactory = Callable[[Path], AbstractContextManager[None]]
ReplaceFile = Callable[[Path, Path], None]


class ExecPolicyWriteError(RuntimeError):
    pass


@dataclass(slots=True, frozen=True)
class ExecPolicyWriteResult:
    status: Literal["created", "existing"]
    pattern_hash: str


def _replace_file(source: Path, target: Path) -> None:
    os.replace(source, target)


@dataclass(slots=True)
class ExecPolicyWriter:
    home_dir: Path
    lock_factory: LockFactory = field(default=execpolicy_file_lock, repr=False)
    replace_file: ReplaceFile = field(default=_replace_file, repr=False)

    def allow_prefix(self, pattern: tuple[str, ...]) -> ExecPolicyWriteResult:
        try:
            candidate = ExecPolicyRule(
                source=ExecPolicySource.USER,
                index=0,
                pattern=pattern,
                decision=ExecPolicyDecision.ALLOW,
            )
            rules_dir = self.home_dir / ".mycli" / "rules"
            rules_path = rules_dir / "default.rules"
            lock_path = rules_dir / "default.rules.lock"
            rules_dir.mkdir(parents=True, exist_ok=True)
            harden_private_path(rules_dir, mode=0o700)
            with self.lock_factory(lock_path):
                if rules_path.exists():
                    harden_private_path(rules_path, mode=0o600)
                existing = ExecPolicyLoader(
                    home_dir=self.home_dir,
                    workspace_root=rules_dir / ".no-project-rules",
                ).load_user_rules()
                if any(
                    rule.pattern == pattern
                    and rule.decision is ExecPolicyDecision.ALLOW
                    for rule in existing.rules
                ):
                    return ExecPolicyWriteResult(
                        status="existing",
                        pattern_hash=candidate.pattern_hash,
                    )
                current = (
                    rules_path.read_text(encoding="utf-8")
                    if rules_path.exists()
                    else ""
                )
                separator = (
                    ""
                    if not current or current.endswith(("\n", "\r"))
                    else "\n"
                )
                line = self._serialize_allow(pattern)
                self._atomic_replace(
                    rules_path,
                    f"{current}{separator}{line}\n",
                )
            return ExecPolicyWriteResult(
                status="created",
                pattern_hash=candidate.pattern_hash,
            )
        except (OSError, ValueError) as exc:
            raise ExecPolicyWriteError(
                "Could not update global Shell approval rules."
            ) from exc

    @staticmethod
    def _serialize_allow(pattern: tuple[str, ...]) -> str:
        encoded = json.dumps(list(pattern), ensure_ascii=True)
        return f'prefix_rule(pattern={encoded}, decision="allow")'

    def _atomic_replace(self, path: Path, content: str) -> None:
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=".default.rules.",
            suffix=".tmp",
            dir=path.parent,
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(
                file_descriptor,
                "w",
                encoding="utf-8",
                newline="",
            ) as handle:
                harden_private_path(temporary_path, mode=0o600)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            self.replace_file(temporary_path, path)
            self._sync_directory(path.parent)
        finally:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _sync_directory(path: Path) -> None:
        if os.name == "nt":
            return
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
