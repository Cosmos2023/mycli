from __future__ import annotations

from collections.abc import Callable
from typing import Any

from mycli.application.turn_service import TurnService


class MycliTuiApp:
    """Temporary facade replaced by the Textual app in later tasks."""

    def __init__(
        self,
        *,
        service: TurnService,
        input_func: Callable[[str], str] | None = None,
        output_func: Callable[[str], Any] | None = None,
    ) -> None:
        self.service = service
        self.input_func = input_func
        self.output_func = output_func

    def run(self) -> int:
        return 0


def run_tui(
    service: TurnService,
    *,
    input_func: Callable[[str], str] | None = None,
    output_func: Callable[[str], Any] | None = None,
) -> int:
    result = MycliTuiApp(
        service=service,
        input_func=input_func,
        output_func=output_func,
    ).run()
    return int(result or 0)
