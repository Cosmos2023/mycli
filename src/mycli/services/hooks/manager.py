from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, replace

from mycli.services.hooks.types import (
    HookAction,
    HookContext,
    HookExecutionStatus,
    HookExecutionSummary,
    HookPoint,
    HookRegistrationSnapshot,
    HookResult,
)

logger = logging.getLogger(__name__)

HookCallback = Callable[[HookContext], HookResult]


@dataclass(slots=True, frozen=True)
class HookExecution:
    results: tuple[HookResult, ...]
    summaries: tuple[HookExecutionSummary, ...]


class HookManager:
    def __init__(self) -> None:
        self._hooks: dict[HookPoint, list[HookCallback]] = defaultdict(list)
        self._state: dict[tuple[HookPoint, str], HookRegistrationSnapshot] = {}
        self._last_execution_summary: tuple[HookExecutionSummary, ...] = ()

    def register(self, point: HookPoint, callback: HookCallback) -> None:
        self._hooks[point].append(callback)
        key = (point, _hook_name(callback))
        self._state.setdefault(
            key,
            HookRegistrationSnapshot(
                hook_point=point,
                hook_name=key[1],
                enabled=True,
            ),
        )

    def execute(self, point: HookPoint, ctx: HookContext) -> list[HookResult]:
        execution = self.execute_with_summary(point, ctx)
        return list(execution.results)

    def execute_with_summary(self, point: HookPoint, ctx: HookContext) -> HookExecution:
        results: list[HookResult] = []
        summaries: list[HookExecutionSummary] = []
        for callback in self._hooks.get(point, []):
            hook_name = _hook_name(callback)
            try:
                result = callback(ctx)
            except Exception as exc:  # pragma: no cover - exercised by focused tests
                logger.error("Hook %s failed at %s: %s", hook_name, point.value, exc)
                summary = HookExecutionSummary(
                    hook_point=point,
                    hook_name=hook_name,
                    status=HookExecutionStatus.ERROR,
                    message=exc.__class__.__name__,
                )
                summaries.append(summary)
                self._record_summary(summary)
                continue
            results.append(result)
            summary = HookExecutionSummary(
                hook_point=point,
                hook_name=hook_name,
                status=HookExecutionStatus.OK,
                action=result.action,
                message=result.message,
            )
            summaries.append(summary)
            self._record_summary(summary)
            if result.action is HookAction.DENY:
                break
        self._last_execution_summary = tuple(summaries)
        return HookExecution(results=tuple(results), summaries=tuple(summaries))

    def last_execution_summary(self) -> tuple[HookExecutionSummary, ...]:
        return self._last_execution_summary

    def snapshot(self) -> tuple[HookRegistrationSnapshot, ...]:
        return tuple(
            self._state[key]
            for key in sorted(
                self._state,
                key=lambda item: (item[0].value, item[1]),
            )
        )

    def _record_summary(self, summary: HookExecutionSummary) -> None:
        key = (summary.hook_point, summary.hook_name)
        current = self._state.get(
            key,
            HookRegistrationSnapshot(
                hook_point=summary.hook_point,
                hook_name=summary.hook_name,
                enabled=True,
            ),
        )
        self._state[key] = replace(
            current,
            call_count=current.call_count + 1,
            error_count=current.error_count + int(summary.status is HookExecutionStatus.ERROR),
            deny_count=current.deny_count + int(summary.action is HookAction.DENY),
            modify_count=current.modify_count + int(summary.action is HookAction.MODIFY),
            last_status=summary.status,
            last_action=summary.action,
            last_message=summary.message,
        )


def _hook_name(callback: HookCallback) -> str:
    return getattr(callback, "__name__", callback.__class__.__name__)
