from __future__ import annotations

import pytest

from mycli.domain.tooling.exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tooling.tool_set import ToolSet
from mycli.tools.base import ToolSpec


def _entry(name: str) -> ToolExposureEntry:
    return ToolExposureEntry(
        route_key=ToolRouteKey.local(name),
        source=ToolRouteSource.REGISTRY,
        spec=ToolSpec(name=name, description=f"Tool {name}"),
    )


def test_tool_set_orders_entries_by_route_key() -> None:
    exposure = ToolExposure(
        entries=(_entry("run_shell"), _entry("list_directory")),
    )

    tool_set = ToolSet.from_exposure(exposure)

    assert [entry.name for entry in tool_set.model_visible_entries()] == [
        "list_directory",
        "run_shell",
    ]


def test_tool_set_order_is_stable_when_exposure_order_changes() -> None:
    first = ToolSet.from_exposure(
        ToolExposure(
            entries=(_entry("run_shell"), _entry("list_directory")),
        )
    )
    second = ToolSet.from_exposure(
        ToolExposure(
            entries=(_entry("list_directory"), _entry("run_shell")),
        )
    )

    assert [entry.name for entry in first.model_visible_entries()] == [
        entry.name for entry in second.model_visible_entries()
    ]


def test_tool_set_rejects_duplicate_route_names() -> None:
    entry = _entry("read_file")

    with pytest.raises(ValueError, match="unique route names"):
        ToolSet(entries=(entry, entry))
