"""Tool-related domain models.

The package keeps exports lazy because ``tool_set`` depends on
``domain.runtime`` and runtime imports conversation/tool call models.
"""

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mycli.domain.tooling.calls import ToolCall, ToolEvidence, ToolResult
    from mycli.domain.tooling.contributed_tools import (
        ToolContributionConflictOutcome,
        ToolContributionDescriptor,
        ToolContributionLifecycleEvent,
        ToolContributionLifecycleState,
        ToolContributionRegistration,
        ToolContributionScope,
        ToolContributionSource,
    )
    from mycli.domain.tooling.exposure import (
        ToolExposure,
        ToolExposureEntry,
        ToolExposureKind,
        ToolRouteKey,
        ToolRouteSource,
    )
    from mycli.domain.tooling.tool_set import ToolSet, ToolSetEntry
    from mycli.domain.tooling.output import (
        ToolImageContent,
        ToolJsonContent,
        ToolModelOutput,
        ToolOutputBudgetClass,
        ToolOutputTruncation,
        ToolTextContent,
    )

__all__ = [
    "ToolContributionConflictOutcome",
    "ToolContributionDescriptor",
    "ToolContributionLifecycleEvent",
    "ToolContributionLifecycleState",
    "ToolContributionRegistration",
    "ToolContributionScope",
    "ToolContributionSource",
    "ToolCall",
    "ToolEvidence",
    "ToolImageContent",
    "ToolJsonContent",
    "ToolModelOutput",
    "ToolOutputBudgetClass",
    "ToolOutputTruncation",
    "ToolTextContent",
    "ToolExposure",
    "ToolExposureEntry",
    "ToolExposureKind",
    "ToolResult",
    "ToolRouteKey",
    "ToolRouteSource",
    "ToolSet",
    "ToolSetEntry",
]

_EXPORT_MODULES = {
    "ToolContributionConflictOutcome": "mycli.domain.tooling.contributed_tools",
    "ToolContributionDescriptor": "mycli.domain.tooling.contributed_tools",
    "ToolContributionLifecycleEvent": "mycli.domain.tooling.contributed_tools",
    "ToolContributionLifecycleState": "mycli.domain.tooling.contributed_tools",
    "ToolContributionRegistration": "mycli.domain.tooling.contributed_tools",
    "ToolContributionScope": "mycli.domain.tooling.contributed_tools",
    "ToolContributionSource": "mycli.domain.tooling.contributed_tools",
    "ToolCall": "mycli.domain.tooling.calls",
    "ToolEvidence": "mycli.domain.tooling.calls",
    "ToolImageContent": "mycli.domain.tooling.output",
    "ToolJsonContent": "mycli.domain.tooling.output",
    "ToolModelOutput": "mycli.domain.tooling.output",
    "ToolOutputBudgetClass": "mycli.domain.tooling.output",
    "ToolOutputTruncation": "mycli.domain.tooling.output",
    "ToolTextContent": "mycli.domain.tooling.output",
    "ToolExposure": "mycli.domain.tooling.exposure",
    "ToolExposureEntry": "mycli.domain.tooling.exposure",
    "ToolExposureKind": "mycli.domain.tooling.exposure",
    "ToolResult": "mycli.domain.tooling.calls",
    "ToolRouteKey": "mycli.domain.tooling.exposure",
    "ToolRouteSource": "mycli.domain.tooling.exposure",
    "ToolSet": "mycli.domain.tooling.tool_set",
    "ToolSetEntry": "mycli.domain.tooling.tool_set",
}


def __getattr__(name: str) -> Any:
    module_name = _EXPORT_MODULES.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module_name), name)
    globals()[name] = value
    return value
