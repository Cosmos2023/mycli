from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from mycli.domain.conversation import Conversation
from mycli.domain.runtime import HistoryItem, PlanState
from mycli.services.storage_layout import MycliStorageLayout
from mycli.services.transcript_projection import (
    project_history_items_for_snapshot,
    project_messages_for_snapshot,
    snapshot_item_to_tui_items,
)


@dataclass(slots=True, frozen=True)
class SessionSnapshotContext:
    """Local metadata used to render the readable session snapshot."""

    workspace_root: Path
    model: str | None = None
    provider: str | None = None
    platform: str | None = None
    plan_state: PlanState | None = None
    subagents: tuple[dict[str, object], ...] = field(default_factory=tuple)


class SessionSnapshotService:
    """Write Hermes-style readable snapshots beside the canonical DB state."""

    def __init__(self, *, home_dir: Path) -> None:
        self._layout = MycliStorageLayout.from_home_dir(home_dir)

    def write_conversation_snapshot(
        self,
        *,
        conversation: Conversation,
        context: SessionSnapshotContext,
        history_items: tuple[HistoryItem, ...] = (),
    ) -> None:
        path = self.snapshot_path(conversation.session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = self._payload(
            conversation=conversation,
            context=context,
            history_items=history_items,
        )
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            encoded = json.dumps(
                payload,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            with temporary.open("w", encoding="utf-8") as handle:
                handle.write(encoded)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def snapshot_path(self, session_id: str) -> Path:
        return self._layout.session_snapshot_path(session_id)

    def read_snapshot(self, session_id: str) -> dict[str, object] | None:
        try:
            payload = json.loads(self.snapshot_path(session_id).read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def legacy_messages(self, session_id: str) -> tuple[dict[str, object], ...]:
        payload = self.read_snapshot(session_id)
        if payload is None or payload.get("schema_version") != 1:
            return ()
        raw_messages = payload.get("messages")
        if not isinstance(raw_messages, list):
            return ()
        return tuple(dict(item) for item in raw_messages if isinstance(item, dict))

    def snapshot_requires_rebuild(self, session_id: str) -> bool:
        payload = self.read_snapshot(session_id)
        return (
            payload is None
            or payload.get("schema_version") != 2
            or not isinstance(payload.get("transcript"), list)
        )

    def load_tui_items(self, session_id: str) -> tuple[dict[str, object], ...]:
        payload = self.read_snapshot(session_id)
        if payload is None or payload.get("schema_version") != 2:
            return ()
        raw_items = payload.get("transcript")
        if not isinstance(raw_items, list):
            return ()
        projected: list[dict[str, object]] = []
        for raw_item in raw_items:
            if isinstance(raw_item, dict):
                projected.extend(snapshot_item_to_tui_items(raw_item))
        return tuple(projected)

    def append_event(
        self,
        *,
        session_id: str,
        event_type: str,
        payload: dict[str, object] | None = None,
    ) -> None:
        path = self._layout.session_events_path(session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        event = {
            "type": event_type,
            "session_id": session_id,
            "created_at": datetime.now(UTC).isoformat(),
            **(payload or {}),
        }
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True))
            handle.write("\n")

    def write_subagent_snapshot(
        self,
        *,
        parent_session_id: str,
        child_session_id: str,
        parent_turn_id: str,
        agent_type: str,
        status: str,
        mode: str,
        description: str,
        report: str,
        tool_calls: int,
        error: str | None,
        started_at: str | None,
        completed_at: str | None,
        context_diagnostics: dict[str, object],
        transcript_items: tuple[dict[str, object], ...],
    ) -> dict[str, object]:
        run_id = self._subagent_run_id(child_session_id)
        path = self._layout.session_dir(parent_session_id) / "subagents" / f"{run_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, object] = {
            "schema_version": 1,
            "run_id": run_id,
            "parent_session_id": parent_session_id,
            "child_session_id": child_session_id,
            "parent_turn_id": parent_turn_id,
            "role": agent_type,
            "status": status,
            "mode": mode,
            "description": description,
            "report": report,
            "tool_calls": tool_calls,
            "error": error,
            "started_at": started_at,
            "completed_at": completed_at,
            "context_diagnostics": context_diagnostics,
            "messages": transcript_items,
            "file_changes": [],
        }
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            temporary.replace(path)
        finally:
            if temporary.exists():
                temporary.unlink()
        return self._subagent_index_entry(payload)

    def _subagent_run_id(self, child_session_id: str) -> str:
        digest = hashlib.sha256(child_session_id.encode("utf-8")).hexdigest()[:16]
        return f"subagent-{digest}"

    def _payload(
        self,
        *,
        conversation: Conversation,
        context: SessionSnapshotContext,
        history_items: tuple[HistoryItem, ...],
    ) -> dict[str, object]:
        now = datetime.now(UTC).isoformat()
        existing = self.read_snapshot(conversation.session_id)
        existing_created_at = existing.get("created_at") if existing is not None else None
        created_at = existing_created_at if isinstance(existing_created_at, str) else now
        transcript_items = (
            project_history_items_for_snapshot(history_items)
            if history_items
            else project_messages_for_snapshot(conversation.messages)
        )
        transcript = [item.to_dict() for item in transcript_items]
        subagents = self._load_subagent_index(conversation.session_id)
        raw_payload: dict[str, object] = {
            "schema_version": 2,
            "session_id": conversation.session_id,
            "title": self._title(transcript),
            "cwd": str(context.workspace_root),
            "created_at": created_at,
            "updated_at": now,
            "model": context.model,
            "provider": context.provider,
            "platform": context.platform,
            "message_count": len(conversation.messages),
            "lineage": {
                "parent_session_id": conversation.parent_id,
                "forked_from_turn_id": None,
                "fork_point": conversation.fork_point,
                "branch_name": "main",
            },
            "state": {
                "status": "active",
                "plan": self._plan_payload(context.plan_state),
            },
            "transcript": transcript,
            "subagents": list(context.subagents or subagents),
            "files": {
                "history_session_id": conversation.session_id,
                "changed": [],
            },
            "links": {
                "events": "events.jsonl",
                "trace": f"../../traces/{conversation.session_id}-trace.jsonl",
                "model_raw": f"../../logs/model-raw/{conversation.session_id}/",
            },
        }
        compacted = _compact_mapping(raw_payload)
        compacted["transcript"] = transcript
        return compacted

    def _plan_payload(self, plan_state: PlanState | None) -> dict[str, object]:
        if plan_state is None or not plan_state.items:
            return {"status": "empty", "items": []}
        status = "active" if plan_state.current_in_progress_item_id() else "idle"
        return {
            "status": status,
            "items": [
                {
                    "id": item.id,
                    "text": item.content,
                    "status": item.status.value,
                }
                for item in plan_state.items
            ],
        }

    def _title(self, transcript: list[dict[str, object]]) -> str | None:
        for item in transcript:
            if item.get("type") != "user_message":
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()[:80]
        return None

    def _load_subagent_index(self, session_id: str) -> tuple[dict[str, object], ...]:
        subagents_dir = self._layout.session_dir(session_id) / "subagents"
        if not subagents_dir.exists():
            return ()
        entries: list[dict[str, object]] = []
        for path in sorted(subagents_dir.glob("*.json")):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                entries.append(self._subagent_index_entry(payload))
        return tuple(entries)

    def _subagent_index_entry(self, payload: dict[str, object]) -> dict[str, object]:
        run_id = str(payload.get("run_id", ""))
        report = payload.get("report")
        summary = report if isinstance(report, str) else ""
        return {
            "run_id": run_id,
            "child_session_id": str(payload.get("child_session_id", "")),
            "parent_turn_id": str(payload.get("parent_turn_id", "")),
            "role": str(payload.get("role", "")),
            "description": str(payload.get("description", "")),
            "status": str(payload.get("status", "")),
            "mode": str(payload.get("mode", "")),
            "summary": summary.strip()[:160],
            "tool_calls": payload.get("tool_calls", 0),
            "error": payload.get("error"),
            "started_at": payload.get("started_at"),
            "completed_at": payload.get("completed_at"),
            "path": f"subagents/{run_id}.json",
        }


def _compact_mapping(payload: dict[str, object]) -> dict[str, object]:
    compacted: dict[str, object] = {}
    for key, value in payload.items():
        cleaned = _compact_value(value)
        if cleaned not in (None, "", [], {}, False):
            compacted[key] = cleaned
    return compacted


def _compact_value(value: object) -> object:
    if isinstance(value, dict):
        return _compact_mapping({str(key): item for key, item in value.items()})
    if isinstance(value, list):
        return [cleaned for item in value if (cleaned := _compact_value(item)) is not None]
    if isinstance(value, tuple):
        return [cleaned for item in value if (cleaned := _compact_value(item)) is not None]
    return value


__all__ = ["SessionSnapshotContext", "SessionSnapshotService"]
