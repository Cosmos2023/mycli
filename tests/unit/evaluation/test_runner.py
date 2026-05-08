from __future__ import annotations

import json
from pathlib import Path

from mycli.domain.runtime import StopReason, TurnItem, TurnItemType, TurnRecord, TurnStatus
from mycli.evaluation.runner import (
    EvaluationScenario,
    EvaluationToolEvent,
    EvaluationTurnResult,
    discover_scenarios,
    load_scenario,
    run_deterministic_checks,
    run_evaluation_scenario,
    write_evaluation_report,
)


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def test_discover_scenarios_prefers_workspace_subdirectory(tmp_path: Path) -> None:
    scenario_root = tmp_path / "scenarios"
    scenario_dir = scenario_root / "04-small-scope-modification"
    _write_text(scenario_dir / "task.md", "# 场景 04：小范围修改任务\n")
    _write_text(scenario_dir / "turns" / "turn-01.txt", "turn 1")
    _write_json(scenario_dir / "checks" / "expected.json", {"scenario_id": "04"})
    (scenario_dir / "fixtures" / "workspace").mkdir(parents=True)

    scenario = discover_scenarios(scenario_root)[0]

    assert scenario.id == "04-small-scope-modification"
    assert scenario.workspace_root == scenario_dir / "fixtures" / "workspace"


def test_load_scenario_supports_numeric_prefix_lookup(tmp_path: Path) -> None:
    scenario_root = tmp_path / "scenarios"
    scenario_dir = scenario_root / "01-boss-message-reply"
    _write_text(scenario_dir / "task.md", "# 场景 01：老板消息回复助手\n")
    _write_text(scenario_dir / "turns" / "turn-01.txt", "turn 1")
    _write_json(scenario_dir / "checks" / "expected.json", {"scenario_id": "01"})
    (scenario_dir / "fixtures").mkdir(parents=True)

    scenario = load_scenario(scenario_root, "01")

    assert scenario.id == "01-boss-message-reply"


def test_run_deterministic_checks_flags_banned_phrases() -> None:
    scenario = EvaluationScenario(
        id="01-boss-message-reply",
        title="场景 01：老板消息回复助手",
        scenario_dir=Path("/tmp/01"),
        workspace_root=Path("/tmp/01/fixtures"),
        turn_paths=(Path("turn-01.txt"),),
        expected_payload={
            "deterministic_checks": {
                "banned_phrases": ["尽量", "大概"],
                "forbidden_topics": ["预算"],
            }
        },
    )
    turn_results = (
        EvaluationTurnResult(
            turn_id="turn-01",
            prompt="prompt",
            assistant_message="我尽量今天给你一个预算答复。",
            rendered_lines=("我尽量今天给你一个预算答复。",),
        ),
    )

    checks = run_deterministic_checks(scenario, turn_results)

    assert any(check.name == "infrastructure:model_requests_completed" and check.passed for check in checks)
    assert any(not check.passed and "尽量" in check.detail for check in checks)
    assert any(not check.passed and "预算" in check.detail for check in checks)


def test_run_deterministic_checks_validates_owner_map_from_tasks_json(tmp_path: Path) -> None:
    workspace_root = tmp_path / "fixtures"
    workspace_root.mkdir(parents=True)
    (workspace_root / "tasks.json").write_text(
        json.dumps(
            [
                {"title": "首页文案定稿", "owner": "沈括", "next_step": "今天中午前出终稿"},
                {"title": "埋点字段口径确认", "owner": "顾林", "next_step": "今晚前回传统一表"},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    scenario = EvaluationScenario(
        id="07-composite-coordination",
        title="场景 07：复合型协同任务",
        scenario_dir=tmp_path,
        workspace_root=workspace_root,
        turn_paths=(Path("turn-01.txt"),),
        expected_payload={
            "deterministic_checks": {
                "expected_owner_map": {
                    "首页文案定稿": "沈括",
                    "埋点字段口径确认": "顾林",
                },
                "must_update_fields": ["owner", "next_step"],
            }
        },
    )

    checks = run_deterministic_checks(scenario, ())

    assert all(check.passed for check in checks)


def test_run_deterministic_checks_validates_required_paths_and_preserved_files(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "fixtures"
    (workspace_root / "src" / "report_tool").mkdir(parents=True)
    (workspace_root / "src" / "report_tool" / "__init__.py").write_text("", encoding="utf-8")
    (workspace_root / "src" / "report_tool_template").mkdir(parents=True)
    (workspace_root / "src" / "report_tool_template" / "service.py").write_text(
        'output_dir = config.get("output-dir", "dist")\n',
        encoding="utf-8",
    )
    scenario = EvaluationScenario(
        id="04-small-scope-modification",
        title="场景 04：小范围修改任务",
        scenario_dir=tmp_path,
        workspace_root=workspace_root,
        turn_paths=(Path("turn-01.txt"),),
        expected_payload={
            "deterministic_checks": {
                "required_paths_exist": ["src/report_tool/__init__.py"],
                "preserved_file_contains": {
                    "src/report_tool_template/service.py": 'config.get("output-dir", "dist")'
                },
            }
        },
    )

    checks = run_deterministic_checks(scenario, ())

    assert any(check.name == "required_path:src/report_tool/__init__.py" and check.passed for check in checks)
    assert any(
        check.name == "preserved_file_contains:src/report_tool_template/service.py"
        and check.passed
        for check in checks
    )


def test_run_deterministic_checks_flags_model_request_failures() -> None:
    scenario = EvaluationScenario(
        id="01-boss-message-reply",
        title="场景 01：老板消息回复助手",
        scenario_dir=Path("/tmp/01"),
        workspace_root=Path("/tmp/01/fixtures"),
        turn_paths=(Path("turn-01.txt"),),
        expected_payload={"deterministic_checks": {}},
    )
    checks = run_deterministic_checks(
        scenario,
        (
            EvaluationTurnResult(
                turn_id="turn-01",
                prompt="prompt",
                assistant_message="Model request failed: timeout",
                rendered_lines=(),
            ),
        ),
    )

    assert any(check.name == "infrastructure:model_requests_completed" and not check.passed for check in checks)


def test_run_deterministic_checks_flags_unconverged_turns() -> None:
    scenario = EvaluationScenario(
        id="04-small-scope-modification",
        title="场景 04：小范围修改任务",
        scenario_dir=Path("/tmp/04"),
        workspace_root=Path("/tmp/04/fixtures"),
        turn_paths=(Path("turn-01.txt"),),
        expected_payload={"deterministic_checks": {}},
    )

    checks = run_deterministic_checks(
        scenario,
        (
            EvaluationTurnResult(
                turn_id="turn-01",
                prompt="prompt",
                assistant_message="Model request failed: timeout",
                rendered_lines=(),
                turn_status=TurnStatus.COMPLETED.value,
                stop_reason=StopReason.MODEL_ERROR.value,
            ),
        ),
    )

    assert any(check.name == "runtime:turns_converged" and not check.passed for check in checks)


def test_write_evaluation_report_persists_json_payload(tmp_path: Path) -> None:
    scenario = EvaluationScenario(
        id="01-boss-message-reply",
        title="场景 01：老板消息回复助手",
        scenario_dir=tmp_path / "scenario",
        workspace_root=tmp_path / "workspace",
        turn_paths=(Path("turn-01.txt"),),
        expected_payload={},
    )
    report_path = write_evaluation_report(
        output_root=tmp_path / "runs",
        report_scenario=scenario,
        session_id="eval-01-demo",
        turn_results=(
            EvaluationTurnResult(
                turn_id="turn-01",
                prompt="prompt",
                assistant_message="answer",
                rendered_lines=("answer",),
                turn_status=TurnStatus.COMPLETED.value,
                stop_reason=StopReason.ASSISTANT_COMPLETED.value,
                tool_events=(
                    EvaluationToolEvent(
                        event_type="tool_call",
                        tool_name="read_file",
                        text="Reading: README.md",
                        call_id="call_1",
                    ),
                ),
            ),
        ),
        checks=(),
    )

    payload = json.loads(report_path.read_text(encoding="utf-8"))

    assert report_path.parent == tmp_path / "runs"
    assert payload["scenario_id"] == "01-boss-message-reply"
    assert payload["session_id"] == "eval-01-demo"
    assert payload["turn_results"][0]["turn_id"] == "turn-01"
    assert payload["turn_results"][0]["turn_status"] == "completed"
    assert payload["turn_results"][0]["stop_reason"] == "assistant_completed"
    assert payload["turn_results"][0]["tool_events"][0]["tool_name"] == "read_file"


def test_run_deterministic_checks_handles_missing_fixed_package_gracefully(tmp_path: Path) -> None:
    scenario = EvaluationScenario(
        id="04-small-scope-modification",
        title="场景 04：小范围修改任务",
        scenario_dir=tmp_path / "scenario",
        workspace_root=tmp_path / "workspace",
        turn_paths=(Path("turn-01.txt"),),
        expected_payload={
            "deterministic_checks": {
                "expected_fixed_behavior": "reports/daily.txt",
            }
        },
    )
    (scenario.workspace_root / "src").mkdir(parents=True)

    checks = run_deterministic_checks(scenario, ())

    assert any(
        check.name == "expected_fixed_behavior" and not check.passed
        for check in checks
    )


def test_run_evaluation_scenario_collects_tool_events_from_turn_record(tmp_path: Path) -> None:
    scenario_dir = tmp_path / "scenario"
    turns_dir = scenario_dir / "turns"
    turns_dir.mkdir(parents=True)
    turn_path = turns_dir / "turn-01.txt"
    turn_path.write_text("inspect repo", encoding="utf-8")
    scenario = EvaluationScenario(
        id="demo",
        title="Demo",
        scenario_dir=scenario_dir,
        workspace_root=scenario_dir / "fixtures",
        turn_paths=(turn_path,),
        expected_payload={"deterministic_checks": {}},
    )

    class FakeService:
        def handle_user_turn(self, message: str):
            assert message == "inspect repo"
            return type(
                "Resp",
                (),
                {
                    "assistant_message": "done",
                    "progress_updates": (),
                    "turn": TurnRecord(
                        thread_id="thread_1",
                        turn_id="turn_1",
                        status=TurnStatus.COMPLETED,
                        started_at="2026-04-16T00:00:00Z",
                        completed_at="2026-04-16T00:00:01Z",
                        stop_reason=StopReason.ASSISTANT_COMPLETED,
                        user_message=message,
                        items=(
                            TurnItem(
                                type=TurnItemType.TOOL_CALL,
                                text="Reading: README.md",
                                tool_name="read_file",
                                call_id="call_1",
                            ),
                            TurnItem(
                                type=TurnItemType.TOOL_RESULT,
                                text="Done: read_file",
                                tool_name="read_file",
                                call_id="call_1",
                            ),
                        ),
                    ),
                },
            )()

    report = run_evaluation_scenario(scenario, FakeService())

    assert report.turn_results[0].tool_events == (
        EvaluationToolEvent(
            event_type="tool_call",
            tool_name="read_file",
            text="Reading: README.md",
            call_id="call_1",
        ),
        EvaluationToolEvent(
            event_type="tool_result",
            tool_name="read_file",
            text="Done: read_file",
            call_id="call_1",
        ),
    )
    assert report.turn_results[0].turn_status == "completed"
    assert report.turn_results[0].stop_reason == "assistant_completed"
