from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any, Literal, cast

import pytest

from mycli.domain.conversation import Conversation, Message, Role
from mycli.domain.runtime import HistoryItem, TurnRollout
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.state.session_service import SessionService

ROOT = Path(__file__).parents[2]
FIXTURE_PATH = (
    ROOT / "tests" / "fixtures" / "node_runtime_m5" / "state_recovery_contract.json"
)
NODE_HELPER = ROOT / "tests" / "integration" / "node_runtime_m5_parity_helper.ts"

Backend = Literal["python", "node"]


@pytest.mark.parametrize(
    ("writer", "reader"),
    [
        ("python", "python"),
        ("python", "node"),
        ("node", "python"),
        ("node", "node"),
    ],
)
def test_m5_state_round_trip(
    writer: Backend,
    reader: Backend,
    tmp_path: Path,
) -> None:
    result = run_case_matrix(
        writer=writer,
        reader=reader,
        db_path=tmp_path / "sessions.db",
    )

    assert result["failed"] == []


@pytest.mark.parametrize("reader", ["python", "node"])
def test_m5_invalid_state_fails_closed(reader: Backend, tmp_path: Path) -> None:
    fixture = _fixture()
    db_path = tmp_path / f"invalid-{reader}.db"
    store = SQLiteSessionStore(db_path)
    for scenario in fixture["invalid_cases"]:
        store.save_state(
            session_id=str(scenario["session_id"]),
            workspace_root=Path(str(fixture["workspace_root"])),
            thread_id=str(scenario["session_id"]),
            state_key=str(scenario["state_key"]),
            payload=cast(dict[str, Any] | list[Any], scenario["payload"]),
        )

    if reader == "python":
        actual = _read_python_invalid(db_path, fixture)
    else:
        actual = _node_command("read_invalid", db_path)

    assert actual == [
        {
            "id": str(scenario["id"]),
            "error_code": str(scenario["expected_error"]),
        }
        for scenario in fixture["invalid_cases"]
    ]


def test_m5_parity_corpus_is_sanitized_and_complete() -> None:
    fixture = _fixture()
    case_ids = [str(scenario["id"]) for scenario in fixture["cases"]]
    serialized = json.dumps(fixture, ensure_ascii=False).lower()

    assert fixture["version"] == 1
    assert len(case_ids) == len(set(case_ids))
    assert {
        "catalog-replay-summary",
        "queue-pending",
        "queue-history-reconciled",
        "approval-waiting",
        "approval-legacy-duplicate",
        "effect-executing",
        "compact-complete",
        "responses-ineligible",
    } == set(case_ids)
    assert {
        "turn_before_reservation",
        "turn_after_reservation",
        "queue_before_save",
        "queue_after_save",
        "queue_commit_after_history",
        "approval_suspend_after_states",
        "approval_after_resolution",
        "effect_after_claim",
        "filesystem_after_commit",
        "approval_result_after_tool",
        "compaction_after_summary_request",
        "compact_after_replacement",
        "snapshot_before_rename",
        "memory_after_topic_write",
        "memory_before_index_write",
        "session_after_prepare",
        "session_after_commit",
    } == set(fixture["failpoints"])
    assert "api_key" not in serialized
    assert "authorization" not in serialized
    assert "bearer " not in serialized


def run_case_matrix(*, writer: Backend, reader: Backend, db_path: Path) -> dict[str, Any]:
    fixture = _fixture()
    try:
        if writer == "python":
            _write_python_cases(db_path, fixture)
        else:
            _node_command("write", db_path)
        actual = (
            _read_python_cases(db_path, fixture)
            if reader == "python"
            else _node_command("read", db_path)
        )
        expected = [
            {"id": str(scenario["id"]), **cast(dict[str, Any], scenario["expected"])}
            for scenario in fixture["cases"]
        ]
        failed = []
        if actual != expected:
            failed = [
                {
                    "kind": "normalized_state_mismatch",
                    "case_ids": [
                        expected_item.get("id")
                        for index, expected_item in enumerate(expected)
                        if index >= len(actual) or actual[index] != expected_item
                    ],
                }
            ]
    except Exception as error:  # The matrix reports a bounded structural failure.
        failed = [
            {
                "kind": type(error).__name__,
                "message": str(error)[:240],
            }
        ]
    return {"writer": writer, "reader": reader, "failed": failed}


def _write_python_cases(db_path: Path, fixture: dict[str, Any]) -> None:
    store = SQLiteSessionStore(db_path)
    service = _python_service(db_path, fixture, store)
    workspace_root = Path(str(fixture["workspace_root"]))
    for scenario in fixture["cases"]:
        session_id = str(scenario["session_id"])
        raw_conversation = scenario.get("conversation")
        if isinstance(raw_conversation, list):
            service.save_conversation(
                Conversation(
                    session_id=session_id,
                    messages=[
                        Message(
                            role=cast(Role, str(item["role"])),
                            content=str(item["content"]),
                        )
                        for item in raw_conversation
                        if isinstance(item, dict)
                    ],
                )
            )
        raw_history = scenario.get("history_items")
        if isinstance(raw_history, list):
            service.append_history_items(
                session_id,
                tuple(
                    HistoryItem.from_dict(item)
                    for item in raw_history
                    if isinstance(item, dict)
                ),
            )
        raw_rollouts = scenario.get("turn_rollouts")
        if isinstance(raw_rollouts, list):
            for item in raw_rollouts:
                if isinstance(item, dict):
                    service.append_turn_rollout(session_id, TurnRollout.from_dict(item))
        for summary in scenario.get("summaries", []):
            store.append_session_summary(
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=session_id,
                summary=str(summary),
            )
        states = scenario.get("states")
        if not isinstance(states, list):
            state_key = scenario.get("state_key")
            states = (
                [{"state_key": state_key, "payload": scenario.get("payload")}]
                if isinstance(state_key, str)
                else []
            )
        for state in states:
            if not isinstance(state, dict) or not isinstance(state.get("state_key"), str):
                continue
            payload = state.get("payload")
            if not isinstance(payload, (dict, list)):
                continue
            store.save_state(
                session_id=session_id,
                workspace_root=workspace_root,
                thread_id=session_id,
                state_key=str(state["state_key"]),
                payload=payload,
            )


def _read_python_cases(db_path: Path, fixture: dict[str, Any]) -> list[dict[str, Any]]:
    store = SQLiteSessionStore(db_path)
    service = _python_service(db_path, fixture, store)
    results: list[dict[str, Any]] = []
    for scenario in fixture["cases"]:
        session_id = str(scenario["session_id"])
        expectation = str(scenario["expect"])
        if expectation == "catalog_replay_summary":
            conversation = service.load_conversation(session_id, repair_snapshot=False)
            results.append(
                {
                    "id": str(scenario["id"]),
                    "conversation_roles": [message.role for message in conversation.messages],
                    "history_types": [
                        item.type.value for item in service.load_replay_history_items(session_id)
                    ],
                    "summary_count": len(store.load_session_summaries(session_id)),
                }
            )
        elif expectation in {"pending_once", "history_committed_once"}:
            queue = service.load_queue_snapshot(session_id)
            raw = cast(dict[str, Any], store.load_state(session_id, "input_queue"))
            results.append(
                {
                    "id": str(scenario["id"]),
                    "revision": queue.revision,
                    "pending_ids": [item.queue_id for item in queue.pending_steers],
                    "committed_ids": _committed_queue_ids(service, session_id),
                    "optional_fields_preserved": raw.get("python_optional_queue") == "preserved"
                    and all(
                        item.get("python_optional_record") == "preserved"
                        for item in raw.get("pending_steers", [])
                        if isinstance(item, dict)
                    ),
                }
            )
        elif expectation == "reemit_choice":
            decision = service.load_pending_decision(session_id)
            suspended = service.load_suspended_turn(session_id)
            effect = cast(
                dict[str, Any], store.load_state(session_id, "node_effect_checkpoint")
            )
            raw_decision = cast(dict[str, Any], store.load_state(session_id, "pending_decision"))
            results.append(
                {
                    "id": str(scenario["id"]),
                    "decision_id": decision.tool_call.call_id if decision else None,
                    "effect_status": effect.get("status"),
                    "suspend_reason": suspended.suspend_reason.value if suspended else None,
                    "conversation_user_count": sum(
                        message.role == "user" for message in suspended.conversation
                    )
                    if suspended
                    else 0,
                    "optional_fields_preserved": raw_decision.get(
                        "python_optional_decision"
                    )
                    == "preserved",
                }
            )
        elif expectation == "deduplicate_original_user":
            raw_history = service.load_history_items(session_id)
            normalized = service.load_replay_history_items(session_id)
            results.append(
                {
                    "id": str(scenario["id"]),
                    "raw_user_count": sum(item.type.value == "user_message" for item in raw_history),
                    "normalized_user_count": sum(
                        item.type.value == "user_message" for item in normalized
                    ),
                    "normalized_history_ids": [item.id for item in normalized],
                }
            )
        elif expectation == "interrupt_unknown":
            effect = cast(
                dict[str, Any], store.load_state(session_id, "node_effect_checkpoint")
            )
            results.append(
                {
                    "id": str(scenario["id"]),
                    "effect_status": effect.get("status"),
                    "recovery": "effect_outcome_unknown",
                    "execute_count": 0,
                }
            )
        elif expectation == "replacement_visible":
            checkpoint = service.load_compact_checkpoint(session_id) or {}
            raw_replacement = checkpoint.get("replacement_messages", [])
            replacement = raw_replacement if isinstance(raw_replacement, list) else []
            results.append(
                {
                    "id": str(scenario["id"]),
                    "window_number": checkpoint.get("window_number"),
                    "replacement_roles": [
                        item.get("role") for item in replacement if isinstance(item, dict)
                    ],
                    "summary_count": len(store.load_session_summaries(session_id)),
                    "optional_fields_preserved": checkpoint.get(
                        "python_optional_checkpoint"
                    )
                    == "preserved",
                }
            )
        elif expectation == "full_replay":
            continuation = service.load_responses_continuation_state(session_id)
            raw = cast(
                dict[str, Any], store.load_state(session_id, "responses_continuation_state")
            )
            results.append(
                {
                    "id": str(scenario["id"]),
                    "eligible": continuation.eligible if continuation else None,
                    "failure_reason": continuation.failure_reason if continuation else None,
                    "request_mode": "canonical_replay",
                    "optional_fields_preserved": raw.get(
                        "python_optional_continuation"
                    )
                    == "preserved",
                }
            )
        else:
            raise AssertionError(f"unknown M5 fixture expectation: {expectation}")
    return results


def _read_python_invalid(db_path: Path, fixture: dict[str, Any]) -> list[dict[str, str | None]]:
    store = SQLiteSessionStore(db_path)
    service = _python_service(db_path, fixture, store)
    results: list[dict[str, str | None]] = []
    for scenario in fixture["invalid_cases"]:
        state_key = str(scenario["state_key"])
        error_code: str | None = None
        try:
            if state_key == "input_queue":
                service.load_queue_snapshot(str(scenario["session_id"]))
            elif state_key == "compact_checkpoint":
                service.load_compact_checkpoint(str(scenario["session_id"]))
            else:
                raise AssertionError(f"unsupported invalid fixture key: {state_key}")
        except ValueError as error:
            raw_code = getattr(error, "code", None)
            error_code = (
                str(raw_code) if isinstance(raw_code, str) else "session_state_invalid"
            )
        results.append({"id": str(scenario["id"]), "error_code": error_code})
    return results


def _python_service(
    db_path: Path,
    fixture: dict[str, Any],
    store: SQLiteSessionStore,
) -> SessionService:
    return SessionService(
        home_dir=db_path.parent,
        workspace_root=Path(str(fixture["workspace_root"])),
        session_store=store,
    )


def _committed_queue_ids(service: SessionService, session_id: str) -> list[str]:
    return sorted(
        str(queue_id)
        for item in service.load_history_items(session_id)
        if isinstance(queue_id := item.metadata.get("queue_id"), str) and queue_id
    )


def _node_command(action: str, db_path: Path) -> list[dict[str, Any]]:
    command = {
        "action": action,
        "db_path": str(db_path),
        "fixture_path": str(FIXTURE_PATH),
    }
    completed = subprocess.run(
        ["node", "--import", "tsx", str(NODE_HELPER)],
        cwd=ROOT,
        input=f"{json.dumps(command, separators=(',', ':'))}\n",
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else ""
        raise AssertionError(f"node parity helper failed ({completed.returncode}): {detail[:160]}")
    rows = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(rows) != 1:
        raise AssertionError("node parity helper must emit exactly one JSONL result")
    payload = json.loads(rows[0])
    if not isinstance(payload, list):
        raise AssertionError("node parity helper result must be an array")
    return cast(list[dict[str, Any]], payload)


def _fixture() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
