from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from importlib import import_module
import json
from pathlib import Path
import re
import sys
from types import TracebackType
from typing import Any, Protocol, cast

from mycli.domain.runtime import TurnItemType, TurnRecord


class TurnHandler(Protocol):
    def handle_user_turn(self, message: str) -> Any:
        """Handle a single user turn."""


@dataclass(slots=True, frozen=True)
class EvaluationScenario:
    id: str
    title: str
    scenario_dir: Path
    workspace_root: Path
    turn_paths: tuple[Path, ...]
    expected_payload: dict[str, object]

    @property
    def metadata(self) -> dict[str, object]:
        metadata = self.expected_payload.get("metadata")
        return metadata if isinstance(metadata, dict) else {}

    @property
    def tier(self) -> str:
        tier = self.metadata.get("tier")
        return tier if isinstance(tier, str) and tier else "capability"


@dataclass(slots=True, frozen=True)
class EvaluationTurnResult:
    turn_id: str
    prompt: str
    assistant_message: str
    rendered_lines: tuple[str, ...] = ()
    tool_events: tuple["EvaluationToolEvent", ...] = ()
    timeline: tuple["EvaluationTimelineEvent", ...] = ()
    turn_status: str | None = None
    stop_reason: str | None = None


@dataclass(slots=True, frozen=True)
class EvaluationToolEvent:
    event_type: str
    tool_name: str | None = None
    text: str | None = None
    call_id: str | None = None


@dataclass(slots=True, frozen=True)
class EvaluationTimelineEvent:
    event_type: str
    text: str | None = None
    tool_name: str | None = None
    call_id: str | None = None


@dataclass(slots=True, frozen=True)
class EvaluationCheckResult:
    name: str
    passed: bool
    detail: str


@dataclass(slots=True, frozen=True)
class EvaluationToolTimelineEntry:
    turn_id: str
    event_type: str
    tool_name: str | None = None
    text: str | None = None
    call_id: str | None = None


@dataclass(slots=True, frozen=True)
class EvaluationApprovalSummary:
    turn_id: str
    event_type: str
    tool_name: str | None = None
    text: str | None = None
    call_id: str | None = None


@dataclass(slots=True, frozen=True)
class EvaluationContextDiagnostic:
    turn_id: str
    event_type: str
    text: str | None = None


@dataclass(slots=True, frozen=True)
class EvaluationFailure:
    kind: str
    name: str
    detail: str
    turn_id: str | None = None
    tool_name: str | None = None
    call_id: str | None = None


@dataclass(slots=True, frozen=True)
class EvaluationScore:
    value: int
    passed_checks: int
    total_checks: int
    failure_count: int


@dataclass(slots=True, frozen=True)
class EvaluationRunReport:
    scenario_id: str
    scenario_title: str
    workspace_root: Path
    turn_results: tuple[EvaluationTurnResult, ...]
    checks: tuple[EvaluationCheckResult, ...] = field(default_factory=tuple)

    @property
    def failed_checks(self) -> tuple[EvaluationCheckResult, ...]:
        return tuple(check for check in self.checks if not check.passed)

    @property
    def final_answer(self) -> str:
        for result in reversed(self.turn_results):
            if result.assistant_message.strip():
                return result.assistant_message
        return ""

    @property
    def tool_timeline(self) -> tuple[EvaluationToolTimelineEntry, ...]:
        entries: list[EvaluationToolTimelineEntry] = []
        for result in self.turn_results:
            for event in result.tool_events:
                entries.append(
                    EvaluationToolTimelineEntry(
                        turn_id=result.turn_id,
                        event_type=event.event_type,
                        tool_name=event.tool_name,
                        text=event.text,
                        call_id=event.call_id,
                    )
                )
        return tuple(entries)

    @property
    def approvals(self) -> tuple[EvaluationApprovalSummary, ...]:
        approvals: list[EvaluationApprovalSummary] = []
        for result in self.turn_results:
            for event in result.timeline:
                if event.event_type not in _APPROVAL_EVENT_TYPES:
                    continue
                approvals.append(
                    EvaluationApprovalSummary(
                        turn_id=result.turn_id,
                        event_type=event.event_type,
                        tool_name=event.tool_name,
                        text=event.text,
                        call_id=event.call_id,
                    )
                )
        return tuple(approvals)

    @property
    def context_diagnostics(self) -> tuple[EvaluationContextDiagnostic, ...]:
        diagnostics: list[EvaluationContextDiagnostic] = []
        for result in self.turn_results:
            for event in result.timeline:
                if event.event_type not in _CONTEXT_DIAGNOSTIC_EVENT_TYPES:
                    continue
                diagnostics.append(
                    EvaluationContextDiagnostic(
                        turn_id=result.turn_id,
                        event_type=event.event_type,
                        text=event.text,
                    )
                )
        return tuple(diagnostics)

    @property
    def failures(self) -> tuple[EvaluationFailure, ...]:
        return _derive_failures(self.turn_results, self.checks)

    @property
    def score(self) -> EvaluationScore:
        passed_checks = sum(1 for check in self.checks if check.passed)
        total_checks = len(self.checks)
        if total_checks:
            value = round((passed_checks / total_checks) * 100)
        else:
            value = 100
        failures = self.failures
        if failures:
            value = max(0, value - _runtime_failure_penalty(failures))
        return EvaluationScore(
            value=value,
            passed_checks=passed_checks,
            total_checks=total_checks,
            failure_count=len(failures),
        )

    def to_dict(self) -> dict[str, object]:
        score = self.score
        return {
            "scenario_id": self.scenario_id,
            "scenario_title": self.scenario_title,
            "workspace_root": str(self.workspace_root),
            "final_answer": self.final_answer,
            "tool_timeline": [
                {
                    "turn_id": event.turn_id,
                    "event_type": event.event_type,
                    "tool_name": event.tool_name,
                    "text": event.text,
                    "call_id": event.call_id,
                }
                for event in self.tool_timeline
            ],
            "approvals": [
                {
                    "turn_id": event.turn_id,
                    "event_type": event.event_type,
                    "tool_name": event.tool_name,
                    "text": event.text,
                    "call_id": event.call_id,
                }
                for event in self.approvals
            ],
            "context_diagnostics": [
                {
                    "turn_id": event.turn_id,
                    "event_type": event.event_type,
                    "text": event.text,
                }
                for event in self.context_diagnostics
            ],
            "failures": [
                {
                    "kind": failure.kind,
                    "name": failure.name,
                    "detail": failure.detail,
                    "turn_id": failure.turn_id,
                    "tool_name": failure.tool_name,
                    "call_id": failure.call_id,
                }
                for failure in self.failures
            ],
            "score": {
                "value": score.value,
                "passed_checks": score.passed_checks,
                "total_checks": score.total_checks,
                "failure_count": score.failure_count,
            },
            "turn_results": [
                {
                    "turn_id": result.turn_id,
                    "prompt": result.prompt,
                    "assistant_message": result.assistant_message,
                    "rendered_lines": list(result.rendered_lines),
                    "turn_status": result.turn_status,
                    "stop_reason": result.stop_reason,
                    "timeline": [
                        {
                            "event_type": event.event_type,
                            "text": event.text,
                            "tool_name": event.tool_name,
                            "call_id": event.call_id,
                        }
                        for event in result.timeline
                    ],
                    "tool_events": [
                        {
                            "event_type": event.event_type,
                            "tool_name": event.tool_name,
                            "text": event.text,
                            "call_id": event.call_id,
                        }
                        for event in result.tool_events
                    ],
                }
                for result in self.turn_results
            ],
            "checks": [
                {
                    "name": check.name,
                    "passed": check.passed,
                    "detail": check.detail,
                }
                for check in self.checks
            ],
        }


def discover_scenarios(root: Path) -> tuple[EvaluationScenario, ...]:
    if not root.exists():
        return ()
    scenarios: list[EvaluationScenario] = []
    for scenario_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        task_path = scenario_dir / "task.md"
        if not task_path.exists():
            continue
        scenarios.append(_build_scenario(scenario_dir))
    return tuple(scenarios)


def load_scenario(root: Path, scenario_id: str) -> EvaluationScenario:
    normalized = scenario_id.strip()
    if not normalized:
        raise ValueError("scenario_id is required")
    scenarios = discover_scenarios(root)
    exact = next((scenario for scenario in scenarios if scenario.id == normalized), None)
    if exact is not None:
        return exact
    prefix_matches = tuple(
        scenario for scenario in scenarios if scenario.id.startswith(f"{normalized}-")
    )
    if len(prefix_matches) == 1:
        return prefix_matches[0]
    if not prefix_matches:
        raise ValueError(f"Unknown evaluation scenario: {scenario_id}")
    raise ValueError(f"Ambiguous evaluation scenario: {scenario_id}")


def run_evaluation_scenario(
    scenario: EvaluationScenario,
    service: TurnHandler,
) -> EvaluationRunReport:
    turn_results: list[EvaluationTurnResult] = []
    for turn_path in scenario.turn_paths:
        prompt = turn_path.read_text(encoding="utf-8")
        response = service.handle_user_turn(prompt)
        turn = getattr(response, "turn", None)
        assistant_message = getattr(response, "assistant_message", "")
        rendered_lines: list[str] = []
        if isinstance(assistant_message, str) and assistant_message:
            rendered_lines.append(assistant_message)
        progress_updates = getattr(response, "progress_updates", ())
        if isinstance(progress_updates, tuple):
            rendered_lines.extend(update for update in progress_updates if isinstance(update, str))
        turn_results.append(
            EvaluationTurnResult(
                turn_id=turn_path.stem,
                prompt=prompt,
                assistant_message=assistant_message if isinstance(assistant_message, str) else "",
                rendered_lines=tuple(rendered_lines),
                tool_events=_extract_tool_events(turn),
                timeline=_extract_timeline_events(turn, assistant_message),
                turn_status=_extract_turn_status(turn),
                stop_reason=_extract_turn_stop_reason(turn),
            )
        )
    checks = run_deterministic_checks(scenario, tuple(turn_results))
    return EvaluationRunReport(
        scenario_id=scenario.id,
        scenario_title=scenario.title,
        workspace_root=scenario.workspace_root,
        turn_results=tuple(turn_results),
        checks=tuple(checks),
    )


def run_deterministic_checks(
    scenario: EvaluationScenario,
    turn_results: tuple[EvaluationTurnResult, ...],
) -> tuple[EvaluationCheckResult, ...]:
    checks = scenario.expected_payload.get("deterministic_checks", {})
    if not isinstance(checks, dict):
        return ()
    combined = "\n".join(result.assistant_message for result in turn_results)
    results: list[EvaluationCheckResult] = []
    infra_failures = tuple(
        result for result in turn_results if result.assistant_message.startswith("Model request failed:")
    )
    results.append(
        EvaluationCheckResult(
            name="infrastructure:model_requests_completed",
            passed=not infra_failures,
            detail=(
                "所有 turn 都成功完成模型请求"
                if not infra_failures
                else f"{len(infra_failures)} 个 turn 出现模型请求失败"
            ),
        )
    )
    incomplete_turns = tuple(
        result
        for result in turn_results
        if result.stop_reason in {"runtime_error", "model_error"}
    )
    results.append(
        EvaluationCheckResult(
            name="runtime:turns_converged",
            passed=not incomplete_turns,
            detail=(
                "所有 turn 都在可接受的 stop reason 下收敛"
                if not incomplete_turns
                else "存在未正常收敛的 turn: "
                + ", ".join(
                    f"{result.turn_id}({result.stop_reason})" for result in incomplete_turns
                )
            ),
        )
    )

    banned_phrases = _as_str_tuple(checks.get("banned_phrases"))
    for phrase in banned_phrases:
        passed = phrase not in combined
        results.append(
            EvaluationCheckResult(
                name=f"banned_phrase:{phrase}",
                passed=passed,
                detail=(
                    f"未检测到禁用词 `{phrase}`"
                    if passed
                    else f"检测到禁用词 `{phrase}`"
                ),
            )
        )

    forbidden_topics = _as_str_tuple(checks.get("forbidden_topics"))
    for topic in forbidden_topics:
        passed = topic not in combined
        results.append(
            EvaluationCheckResult(
                name=f"forbidden_topic:{topic}",
                passed=passed,
                detail=(
                    f"未检测到禁止主题 `{topic}`"
                    if passed
                    else f"检测到禁止主题 `{topic}`"
                ),
            )
        )

    required_sources = _as_str_tuple(checks.get("required_sources"))
    for source in required_sources:
        passed = source in combined
        results.append(
            EvaluationCheckResult(
                name=f"required_source:{source}",
                passed=passed,
                detail=(
                    f"输出中包含来源 `{source}`"
                    if passed
                    else f"输出中未包含来源 `{source}`"
                ),
            )
        )

    expected_values = checks.get("expected_values")
    if isinstance(expected_values, dict):
        for key, value in expected_values.items():
            rendered = str(value)
            passed = rendered in combined
            results.append(
                EvaluationCheckResult(
                    name=f"expected_value:{key}",
                    passed=passed,
                    detail=(
                        f"输出中包含期望值 `{rendered}`"
                        if passed
                        else f"输出中未包含期望值 `{rendered}`"
                    ),
                )
            )

    must_identify_signals = _as_str_tuple(checks.get("must_identify_signals"))
    for signal in must_identify_signals:
        passed = signal in combined
        results.append(
            EvaluationCheckResult(
                name=f"signal:{signal}",
                passed=passed,
                detail=(
                    f"输出中包含关键信号 `{signal}`"
                    if passed
                    else f"输出中未包含关键信号 `{signal}`"
                ),
            )
        )

    banned_names = _as_str_tuple(checks.get("banned_names_in_turn_04_and_05"))
    late_turn_text = "\n".join(
        result.assistant_message
        for result in turn_results
        if result.turn_id in {"turn-04", "turn-05"}
    )
    for name in banned_names:
        passed = name not in late_turn_text
        results.append(
            EvaluationCheckResult(
                name=f"late_turn_banned_name:{name}",
                passed=passed,
                detail=(
                    f"Turn 04-05 未出现 `{name}`"
                    if passed
                    else f"Turn 04-05 出现了 `{name}`"
                ),
            )
        )

    if checks.get("must_include_sources") is True:
        passed = "http://" in combined or "https://" in combined
        results.append(
            EvaluationCheckResult(
                name="must_include_sources",
                passed=passed,
                detail="输出中包含可见来源链接" if passed else "输出中未找到可见来源链接",
            )
        )

    updated_budget_cap = checks.get("updated_budget_cap")
    if isinstance(updated_budget_cap, int):
        rendered_budget = str(updated_budget_cap)
        passed = rendered_budget in combined
        results.append(
            EvaluationCheckResult(
                name="updated_budget_cap",
                passed=passed,
                detail=(
                    f"输出中体现了更新后的预算 `{rendered_budget}`"
                    if passed
                    else f"输出中未体现更新后的预算 `{rendered_budget}`"
                ),
            )
        )

    if checks.get("must_explain_rejection") is True:
        turn_04_05_text = "\n".join(
            result.assistant_message
            for result in turn_results
            if result.turn_id in {"turn-04", "turn-05"}
        )
        passed = any(
            marker in turn_04_05_text
            for marker in ("因为", "原因", "不选", "放弃", "不推荐", "淘汰")
        )
        results.append(
            EvaluationCheckResult(
                name="must_explain_rejection",
                passed=passed,
                detail="输出中解释了放弃项原因" if passed else "输出中未明确解释放弃项原因",
            )
        )

    if checks.get("must_distinguish_fact_vs_recommendation") is True:
        passed = any(marker in combined for marker in ("事实", "建议"))
        results.append(
            EvaluationCheckResult(
                name="must_distinguish_fact_vs_recommendation",
                passed=passed,
                detail="输出中区分了事实与建议" if passed else "输出中未显式区分事实与建议",
            )
        )

    expected_totals = checks.get("expected_totals")
    if isinstance(expected_totals, dict):
        for key, value in expected_totals.items():
            rendered = str(value)
            passed = rendered in combined
            results.append(
                EvaluationCheckResult(
                    name=f"expected_total:{key}",
                    passed=passed,
                    detail=(
                        f"输出中包含汇总值 `{rendered}`"
                        if passed
                        else f"输出中未包含汇总值 `{rendered}`"
                    ),
                )
            )

    must_prioritize = _as_str_tuple(checks.get("must_prioritize"))
    for rule in must_prioritize:
        passed = _check_priority_rule(rule, combined)
        results.append(
            EvaluationCheckResult(
                name=f"priority_rule:{rule}",
                passed=passed,
                detail="输出满足优先级要求" if passed else f"输出未满足优先级要求 `{rule}`",
            )
        )

    time_constraints = _as_str_tuple(checks.get("time_constraints"))
    for constraint in time_constraints:
        passed = _check_time_constraint(constraint, combined)
        results.append(
            EvaluationCheckResult(
                name=f"time_constraint:{constraint}",
                passed=passed,
                detail="输出体现了时间限制" if passed else f"输出未体现时间限制 `{constraint}`",
            )
        )

    expected_owner_map = checks.get("expected_owner_map")
    if isinstance(expected_owner_map, dict):
        results.extend(_check_expected_owner_map(scenario.workspace_root, expected_owner_map))

    required_paths_exist = _as_str_tuple(checks.get("required_paths_exist"))
    if required_paths_exist:
        results.extend(_check_required_paths_exist(scenario.workspace_root, required_paths_exist))

    preserved_file_contains = checks.get("preserved_file_contains")
    if isinstance(preserved_file_contains, dict):
        results.extend(_check_file_contains(scenario.workspace_root, preserved_file_contains, "preserved"))

    must_update_fields = _as_str_tuple(checks.get("must_update_fields"))
    if must_update_fields:
        results.extend(_check_updated_fields(scenario.workspace_root, must_update_fields))

    expected_fixed_behavior = checks.get("expected_fixed_behavior")
    if isinstance(expected_fixed_behavior, str):
        results.append(
            _check_expected_fixed_behavior(scenario.workspace_root, expected_fixed_behavior)
        )

    unknown_answer_topics = _as_str_tuple(checks.get("unknown_answer_topics"))
    if unknown_answer_topics and turn_results:
        final_text = turn_results[-1].assistant_message
        for topic in unknown_answer_topics:
            passed = (
                any(marker in final_text for marker in ("没有明确", "未说明", "无法确认", "未给出"))
                and re.search(r"\d", final_text) is None
            )
            results.append(
                EvaluationCheckResult(
                    name=f"unknown_topic:{topic}",
                    passed=passed,
                    detail=(
                        f"对 `{topic}` 保持了克制"
                        if passed
                        else f"对 `{topic}` 的回答看起来仍然过于确定"
                    ),
                )
            )

    return tuple(results)


def render_evaluation_report(report: EvaluationRunReport) -> list[str]:
    score = report.score
    final_preview = _preview_text(report.final_answer, limit=160)
    lines = [
        f"[eval] scenario: {report.scenario_id}",
        f"[eval] title: {report.scenario_title}",
        f"[eval] workspace: {report.workspace_root}",
        f"[eval] turns: {len(report.turn_results)}",
        f"[eval] score: {score.value}/100",
        f"[eval] final_answer: {final_preview or '(empty)'}",
        f"[eval] tool_timeline: {len(report.tool_timeline)} events",
        f"[eval] approvals: {len(report.approvals)} events",
        f"[eval] context_diagnostics: {len(report.context_diagnostics)} events",
        f"[eval] failures: {len(report.failures)}",
    ]
    passed = sum(1 for check in report.checks if check.passed)
    failed = len(report.checks) - passed
    lines.append(f"[eval] checks: {passed} passed, {failed} failed")
    for failure in report.failures:
        location = f" turn={failure.turn_id}" if failure.turn_id else ""
        lines.append(f"[eval] FAILURE {failure.kind}:{failure.name}{location}: {failure.detail}")
    for check in report.checks:
        status = "PASS" if check.passed else "FAIL"
        lines.append(f"[eval] {status} {check.name}: {check.detail}")
    return lines


def write_evaluation_report(
    *,
    output_root: Path,
    report_scenario: EvaluationScenario,
    session_id: str,
    turn_results: tuple[EvaluationTurnResult, ...],
    checks: tuple[EvaluationCheckResult, ...],
) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(tz=UTC).strftime("%Y%m%dT%H%M%SZ")
    report_path = output_root / f"{report_scenario.id}-{timestamp}.json"
    report = EvaluationRunReport(
        scenario_id=report_scenario.id,
        scenario_title=report_scenario.title,
        workspace_root=report_scenario.workspace_root,
        turn_results=turn_results,
        checks=checks,
    )
    payload = report.to_dict()
    payload["session_id"] = session_id
    payload["scenario_dir"] = str(report_scenario.scenario_dir)
    payload["metadata"] = report_scenario.metadata
    payload["written_at"] = timestamp
    report_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return report_path


def _build_scenario(scenario_dir: Path) -> EvaluationScenario:
    task_path = scenario_dir / "task.md"
    task_title = _extract_title(task_path.read_text(encoding="utf-8"))
    turn_paths = tuple(sorted((scenario_dir / "turns").glob("turn-*.txt")))
    expected_payload = _load_expected_payload(scenario_dir / "checks" / "expected.json")
    workspace_root = scenario_dir / "fixtures" / "workspace"
    if not workspace_root.exists():
        workspace_root = scenario_dir / "fixtures"
    return EvaluationScenario(
        id=scenario_dir.name,
        title=task_title,
        scenario_dir=scenario_dir,
        workspace_root=workspace_root,
        turn_paths=turn_paths,
        expected_payload=expected_payload,
    )


def _extract_title(task_markdown: str) -> str:
    for line in task_markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:]
    return "Untitled evaluation scenario"


def _load_expected_payload(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def _as_str_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _check_priority_rule(rule: str, text: str) -> bool:
    normalized = rule.lower()
    if normalized == "a over b":
        index_a = text.find("A")
        index_b = text.find("B")
        return index_a != -1 and index_b != -1 and index_a < index_b
    return False


def _check_time_constraint(rule: str, text: str) -> bool:
    lowered = text.lower()
    if rule == "no external meeting before 14:00":
        return "14:00" in text or "两点" in text or "下午两点" in text
    if rule == "reserve 1 hour buffer":
        return "1 小时" in text or "一小时" in text or "缓冲" in text
    return rule.lower() in lowered


def _check_expected_owner_map(
    workspace_root: Path,
    expected_owner_map: dict[object, object],
) -> tuple[EvaluationCheckResult, ...]:
    tasks_path = workspace_root / "tasks.json"
    if not tasks_path.exists():
        return (
            EvaluationCheckResult(
                name="expected_owner_map",
                passed=False,
                detail=f"未找到 `{tasks_path.name}`，无法检查 owner 映射",
            ),
        )
    try:
        payload = json.loads(tasks_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return (
            EvaluationCheckResult(
                name="expected_owner_map",
                passed=False,
                detail=f"`{tasks_path.name}` 不是合法 JSON：{exc.msg}",
            ),
        )
    if not isinstance(payload, list):
        return (
            EvaluationCheckResult(
                name="expected_owner_map",
                passed=False,
                detail="tasks.json 不是数组结构",
            ),
        )
    indexed: dict[str, dict[str, object]] = {}
    for item in payload:
        if isinstance(item, dict):
            title = item.get("title")
            if isinstance(title, str):
                indexed[title] = item
    results: list[EvaluationCheckResult] = []
    for title, owner in expected_owner_map.items():
        if not isinstance(title, str) or not isinstance(owner, str):
            continue
        actual_owner = indexed.get(title, {}).get("owner")
        passed = actual_owner == owner
        results.append(
            EvaluationCheckResult(
                name=f"owner_map:{title}",
                passed=passed,
                detail=(
                    f"`{title}` 的 owner 正确为 `{owner}`"
                    if passed
                    else f"`{title}` 的 owner 不正确，当前值为 `{actual_owner}`"
                ),
            )
        )
    return tuple(results)


def _check_updated_fields(
    workspace_root: Path,
    fields: tuple[str, ...],
) -> tuple[EvaluationCheckResult, ...]:
    tasks_path = workspace_root / "tasks.json"
    if not tasks_path.exists():
        return ()
    try:
        payload = json.loads(tasks_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return (
            EvaluationCheckResult(
                name="updated_fields",
                passed=False,
                detail=f"`{tasks_path.name}` 不是合法 JSON：{exc.msg}",
            ),
        )
    if not isinstance(payload, list):
        return ()
    results: list[EvaluationCheckResult] = []
    for field_name in fields:
        values: list[object] = []
        for item in payload:
            if isinstance(item, dict):
                values.append(item.get(field_name))
        passed = bool(values) and all(
            isinstance(value, str) and bool(value.strip()) for value in values
        )
        results.append(
            EvaluationCheckResult(
                name=f"updated_field:{field_name}",
                passed=passed,
                detail=(
                    f"字段 `{field_name}` 已写回"
                    if passed
                    else f"字段 `{field_name}` 仍存在空值"
                ),
            )
        )
    return tuple(results)


def _check_required_paths_exist(
    workspace_root: Path,
    paths: tuple[str, ...],
) -> tuple[EvaluationCheckResult, ...]:
    results: list[EvaluationCheckResult] = []
    for relative_path in paths:
        candidate = workspace_root / relative_path
        passed = candidate.exists()
        results.append(
            EvaluationCheckResult(
                name=f"required_path:{relative_path}",
                passed=passed,
                detail=(
                    f"已生成 `{relative_path}`"
                    if passed
                    else f"缺少 `{relative_path}`"
                ),
            )
        )
    return tuple(results)


def _check_file_contains(
    workspace_root: Path,
    expectations: dict[object, object],
    label: str,
) -> tuple[EvaluationCheckResult, ...]:
    results: list[EvaluationCheckResult] = []
    for relative_path, snippet in expectations.items():
        if not isinstance(relative_path, str) or not isinstance(snippet, str):
            continue
        candidate = workspace_root / relative_path
        if not candidate.exists():
            results.append(
                EvaluationCheckResult(
                    name=f"{label}_file_contains:{relative_path}",
                    passed=False,
                    detail=f"未找到 `{relative_path}`，无法检查保留内容",
                )
            )
            continue
        content = candidate.read_text(encoding="utf-8")
        passed = snippet in content
        results.append(
            EvaluationCheckResult(
                name=f"{label}_file_contains:{relative_path}",
                passed=passed,
                detail=(
                    f"`{relative_path}` 保留了预期片段"
                    if passed
                    else f"`{relative_path}` 未保留预期片段"
                ),
            )
        )
    return tuple(results)


def _check_expected_fixed_behavior(
    workspace_root: Path,
    expected_fixed_behavior: str,
) -> EvaluationCheckResult:
    workspace_src = workspace_root / "src"
    if not workspace_src.exists():
        return EvaluationCheckResult(
            name="expected_fixed_behavior",
            passed=False,
            detail="未找到可导入的 `src/` 目录，无法验证修复后的行为",
        )
    try:
        with _sys_path_prepended(workspace_src):
            report_service = import_module("report_tool.service")
            build_output_path = cast(Any, report_service).build_output_path
            actual = build_output_path({"output_dir": "reports"}, "daily.txt")
    except Exception as exc:
        return EvaluationCheckResult(
            name="expected_fixed_behavior",
            passed=False,
            detail=f"无法导入或执行修复后的行为检查：{exc}",
        )
    passed = actual == expected_fixed_behavior
    return EvaluationCheckResult(
        name="expected_fixed_behavior",
        passed=passed,
        detail=(
            f"修复后行为正确：`{actual}`"
            if passed
            else f"修复后行为不正确，当前为 `{actual}`"
        ),
    )


def _extract_tool_events(turn: object) -> tuple[EvaluationToolEvent, ...]:
    if not isinstance(turn, TurnRecord):
        return ()
    events: list[EvaluationToolEvent] = []
    for item in turn.items:
        if item.type not in {TurnItemType.TOOL_CALL, TurnItemType.TOOL_RESULT}:
            continue
        events.append(
            EvaluationToolEvent(
                event_type=item.type.value,
                tool_name=item.tool_name,
                text=item.text,
                call_id=item.call_id,
            )
        )
    return tuple(events)


def _extract_timeline_events(
    turn: object,
    assistant_message: object,
) -> tuple[EvaluationTimelineEvent, ...]:
    events: list[EvaluationTimelineEvent] = []
    if isinstance(turn, TurnRecord):
        for item in turn.items:
            if item.type is TurnItemType.USER_MESSAGE:
                continue
            _append_timeline_event(
                events,
                EvaluationTimelineEvent(
                    event_type=item.type.value,
                    text=item.text,
                    tool_name=item.tool_name,
                    call_id=item.call_id,
                ),
            )
    if not any(event.event_type == TurnItemType.ASSISTANT_MESSAGE.value for event in events):
        if isinstance(assistant_message, str) and assistant_message:
            events.append(
                EvaluationTimelineEvent(
                    event_type=TurnItemType.ASSISTANT_MESSAGE.value,
                    text=assistant_message,
                )
            )
    return tuple(events)


def _append_timeline_event(
    events: list[EvaluationTimelineEvent],
    event: EvaluationTimelineEvent,
) -> None:
    if not events or not _should_coalesce_timeline_event(events[-1], event):
        events.append(event)
        return
    previous = events[-1]
    events[-1] = replace(previous, text=f"{previous.text or ''}{event.text or ''}")


def _should_coalesce_timeline_event(
    previous: EvaluationTimelineEvent,
    current: EvaluationTimelineEvent,
) -> bool:
    coalesced_types = {
        TurnItemType.ASSISTANT_MESSAGE.value,
        TurnItemType.REASONING.value,
        TurnItemType.TOOL_EXPOSURE.value,
        TurnItemType.WARNING.value,
    }
    return (
        previous.event_type in coalesced_types
        and previous.event_type == current.event_type
        and previous.tool_name == current.tool_name
        and previous.call_id == current.call_id
    )


def _extract_turn_status(turn: object) -> str | None:
    if not isinstance(turn, TurnRecord):
        return None
    return turn.status.value


def _extract_turn_stop_reason(turn: object) -> str | None:
    if not isinstance(turn, TurnRecord) or turn.stop_reason is None:
        return None
    return turn.stop_reason.value


_APPROVAL_EVENT_TYPES = frozenset(
    {
        TurnItemType.APPROVAL_REQUEST.value,
        TurnItemType.APPROVAL_RESOLUTION.value,
        "approval_allowance",
        "approval_auto_allowed",
        "approval_resolution",
    }
)

_CONTEXT_DIAGNOSTIC_EVENT_TYPES = frozenset(
    {
        "context_diagnostics",
        "cache_shape_diagnostic",
        "context_budget_diagnostic",
        "subagent_context_fork",
    }
)

_FAILED_TURN_STATUSES = frozenset(
    {
        "failed",
        "interrupted",
        "rejected",
    }
)

_FAILED_STOP_REASONS = frozenset(
    {
        "runtime_error",
        "model_error",
        "context_window_exceeded",
        "retry_exhausted",
        "transport_failed",
        "auth_failed",
        "rate_limited",
        "approval_rejected",
    }
)

_TOOL_FAILURE_MARKERS = frozenset(
    {
        "failed",
        "failure",
        "error",
        "denied",
        "rejected",
        "approval_required",
        "not_git_repository",
        "validation",
        "timeout",
        "失败",
        "错误",
        "拒绝",
    }
)


def _derive_failures(
    turn_results: tuple[EvaluationTurnResult, ...],
    checks: tuple[EvaluationCheckResult, ...],
) -> tuple[EvaluationFailure, ...]:
    failures: list[EvaluationFailure] = []
    for check in checks:
        if not check.passed:
            failures.append(
                EvaluationFailure(
                    kind="check",
                    name=check.name,
                    detail=check.detail,
                )
            )
    for result in turn_results:
        if result.turn_status in _FAILED_TURN_STATUSES:
            failures.append(
                EvaluationFailure(
                    kind="turn",
                    name=result.turn_status or "unknown_status",
                    detail=f"Turn ended with status `{result.turn_status}`",
                    turn_id=result.turn_id,
                )
            )
        if result.stop_reason in _FAILED_STOP_REASONS:
            failures.append(
                EvaluationFailure(
                    kind="turn_stop",
                    name=result.stop_reason or "unknown_stop_reason",
                    detail=f"Turn stopped because `{result.stop_reason}`",
                    turn_id=result.turn_id,
                )
            )
        for event in result.tool_events:
            if event.event_type != TurnItemType.TOOL_RESULT.value:
                continue
            text = event.text or ""
            lowered = text.lower()
            if not any(marker in lowered for marker in _TOOL_FAILURE_MARKERS):
                continue
            failures.append(
                EvaluationFailure(
                    kind="tool",
                    name=event.tool_name or "unknown_tool",
                    detail=_preview_text(text, limit=240),
                    turn_id=result.turn_id,
                    tool_name=event.tool_name,
                    call_id=event.call_id,
                )
            )
    return tuple(failures)


def _runtime_failure_penalty(failures: tuple[EvaluationFailure, ...]) -> int:
    penalty = 0
    for failure in failures:
        if failure.kind == "check":
            continue
        penalty += 10
    return min(50, penalty)


def _preview_text(text: str | None, *, limit: int) -> str:
    if not text:
        return ""
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 1]}…"


class _sys_path_prepended:
    def __init__(self, path: Path) -> None:
        self._path = str(path)

    def __enter__(self) -> None:
        sys.path.insert(0, self._path)

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            sys.path.remove(self._path)
        except ValueError:
            pass
