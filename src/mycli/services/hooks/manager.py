from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Callable

from mycli.services.hooks.types import HookAction, HookContext, HookPoint, HookResult

logger = logging.getLogger(__name__)

HookCallback = Callable[[HookContext], HookResult]


class HookManager:
    def __init__(self) -> None:
        self._hooks: dict[HookPoint, list[HookCallback]] = defaultdict(list)

    def register(self, point: HookPoint, callback: HookCallback) -> None:
        self._hooks[point].append(callback)

    def execute(self, point: HookPoint, ctx: HookContext) -> list[HookResult]:
        results: list[HookResult] = []
        for callback in self._hooks.get(point, []):
            try:
                result = callback(ctx)
            except Exception as exc:  # pragma: no cover - exercised by focused tests
                logger.error("Hook %s failed at %s: %s", callback.__name__, point.value, exc)
                continue
            results.append(result)
            if result.action is HookAction.DENY:
                break
        return results
