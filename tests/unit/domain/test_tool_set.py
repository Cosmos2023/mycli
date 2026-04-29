from __future__ import annotations

import pytest

from mycli.domain.tool_exposure import (
    ToolExposure,
    ToolExposureEntry,
    ToolExposureKind,
    ToolRouteKey,
    ToolRouteSource,
)
from mycli.domain.tool_set import ToolSet
from mycli.tools.base import ToolSpec


def _entry(name: str, kind: ToolExposureKind) -> ToolExposureEntry:
    return ToolExposureEntry(
        route_key=ToolRouteKey.local(name),
        kind=kind,
        source=ToolRouteSource.REGISTRY,
        spec=ToolSpec(name=name, description=f"Tool {name}"),
    )


def test_tool_set_orders_entries_by_route_key_not_compatibility_group() -> None:
    exposure = ToolExposure(
        direct=(_entry("run_shell", ToolExposureKind.DIRECT),),
        deferred=(_entry("list_directory", ToolExposureKind.DEFERRED),),
    )

    tool_set = ToolSet.from_exposure(exposure)

    assert [entry.name for entry in tool_set.model_visible_entries()] == [
        "list_directory",
        "run_shell",
    ]


def test_tool_set_order_is_stable_when_compatibility_groups_swap() -> None:
    first = ToolSet.from_exposure(
        ToolExposure(
            direct=(_entry("run_shell", ToolExposureKind.DIRECT),),
            deferred=(_entry("list_directory", ToolExposureKind.DEFERRED),),
        )
    )
    second = ToolSet.from_exposure(
        ToolExposure(
            direct=(_entry("list_directory", ToolExposureKind.DIRECT),),
            deferred=(_entry("run_shell", ToolExposureKind.DEFERRED),),
        )
    )

    assert [entry.name for entry in first.model_visible_entries()] == [
        entry.name for entry in second.model_visible_entries()
    ]
    assert first.order_hash() == second.order_hash()


def test_tool_set_rejects_duplicate_route_names() -> None:
    entry = _entry("read_file", ToolExposureKind.DIRECT)

    with pytest.raises(ValueError, match="unique route names"):
        ToolSet(entries=(entry, entry))
