from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path

from mycli.infrastructure.filesystem import ensure_parent
from mycli.services.hooks.config import ConfiguredHookSpec, HookConfigScope
from mycli.services.hooks.types import HookPoint


@dataclass(slots=True, frozen=True)
class HookAllowlistEntry:
    source: HookConfigScope
    hook_id: str
    hook_point: HookPoint
    command_digest: str
    approved_at: str = ""

    def to_dict(self) -> dict[str, str]:
        payload = {
            "source": self.source.value,
            "hook_id": self.hook_id,
            "hook_point": self.hook_point.value,
            "command_digest": self.command_digest,
        }
        if self.approved_at:
            payload["approved_at"] = self.approved_at
        return payload

    @classmethod
    def from_dict(cls, payload: object) -> "HookAllowlistEntry | None":
        if not isinstance(payload, dict):
            return None
        try:
            source = HookConfigScope(str(payload["source"]))
            hook_point = HookPoint(str(payload["hook_point"]))
        except (KeyError, ValueError):
            return None
        hook_id = payload.get("hook_id")
        command_digest = payload.get("command_digest")
        approved_at = payload.get("approved_at", "")
        if not isinstance(hook_id, str) or not hook_id.strip():
            return None
        if not isinstance(command_digest, str) or not command_digest.startswith("sha256:"):
            return None
        if not isinstance(approved_at, str):
            approved_at = ""
        return cls(
            source=source,
            hook_id=hook_id.strip(),
            hook_point=hook_point,
            command_digest=command_digest,
            approved_at=approved_at,
        )


@dataclass(slots=True, frozen=True)
class HookAllowlistStatus:
    allowed: bool
    reason: str
    digest: str

    def safe_line(self, spec: ConfiguredHookSpec) -> str:
        state = "allowed" if self.allowed else "not_allowed"
        return f"{spec.name} allowlist={state} reason={self.reason} digest={self.digest}"


class HookAllowlist:
    def __init__(self, *, home_dir: Path) -> None:
        self._path = home_dir / ".mycli" / "hook-allowlist.json"
        self._entries, self._issues = self._load()

    @property
    def path(self) -> Path:
        return self._path

    @property
    def issues(self) -> tuple[str, ...]:
        return self._issues

    @property
    def entries(self) -> tuple[HookAllowlistEntry, ...]:
        return self._entries

    def status_for(self, spec: ConfiguredHookSpec) -> HookAllowlistStatus:
        digest = command_digest(spec.command)
        for entry in self._entries:
            if (
                entry.source is spec.source
                and entry.hook_id == spec.hook_id
                and entry.hook_point is spec.hook_point
                and entry.command_digest == digest
            ):
                return HookAllowlistStatus(allowed=True, reason="matched", digest=digest)
        if not self._path.exists():
            return HookAllowlistStatus(allowed=False, reason="allowlist_missing", digest=digest)
        return HookAllowlistStatus(allowed=False, reason="entry_missing_or_digest_mismatch", digest=digest)

    def write_allowed(self, specs: tuple[ConfiguredHookSpec, ...]) -> None:
        entries = [
            HookAllowlistEntry(
                source=spec.source,
                hook_id=spec.hook_id,
                hook_point=spec.hook_point,
                command_digest=command_digest(spec.command),
                approved_at=datetime.now(UTC).isoformat(),
            )
            for spec in specs
        ]
        ensure_parent(self._path)
        self._path.write_text(
            json.dumps({"allowed": [entry.to_dict() for entry in entries]}, indent=2),
            encoding="utf-8",
        )

    def approve(self, spec: ConfiguredHookSpec) -> HookAllowlistEntry:
        if self._issues:
            raise ValueError("; ".join(self._issues))
        digest = command_digest(spec.command)
        approved = HookAllowlistEntry(
            source=spec.source,
            hook_id=spec.hook_id,
            hook_point=spec.hook_point,
            command_digest=digest,
            approved_at=datetime.now(UTC).isoformat(),
        )
        entries = [
            entry
            for entry in self._entries
            if not _same_hook_identity(entry, spec)
        ]
        entries.append(approved)
        self._write_entries(tuple(entries))
        self._entries = tuple(entries)
        self._issues = ()
        return approved

    def revoke(self, spec: ConfiguredHookSpec) -> bool:
        if self._issues:
            raise ValueError("; ".join(self._issues))
        entries = tuple(entry for entry in self._entries if not _same_hook_identity(entry, spec))
        removed = len(entries) != len(self._entries)
        if removed or self._path.exists():
            self._write_entries(entries)
        self._entries = entries
        self._issues = ()
        return removed

    def _load(self) -> tuple[tuple[HookAllowlistEntry, ...], tuple[str, ...]]:
        if not self._path.exists():
            return (), ()
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            return (), (f"allowlist not parseable: {exc}",)
        if not isinstance(payload, dict):
            return (), ("allowlist root must be an object",)
        raw_entries = payload.get("allowed", [])
        if not isinstance(raw_entries, list):
            return (), ("allowlist.allowed must be a list",)
        entries: list[HookAllowlistEntry] = []
        issues: list[str] = []
        for index, raw_entry in enumerate(raw_entries):
            parsed = HookAllowlistEntry.from_dict(raw_entry)
            if parsed is None:
                issues.append(f"allowlist.allowed[{index}] invalid")
                continue
            entries.append(parsed)
        return tuple(entries), tuple(issues)

    def _write_entries(self, entries: tuple[HookAllowlistEntry, ...]) -> None:
        ensure_parent(self._path)
        self._path.write_text(
            json.dumps({"allowed": [entry.to_dict() for entry in entries]}, indent=2),
            encoding="utf-8",
        )


def command_digest(command: tuple[str, ...]) -> str:
    canonical = "\0".join(command)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _same_hook_identity(entry: HookAllowlistEntry, spec: ConfiguredHookSpec) -> bool:
    return (
        entry.source is spec.source
        and entry.hook_id == spec.hook_id
        and entry.hook_point is spec.hook_point
    )
