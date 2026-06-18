from mycli.tools.routing.tool_exposure_planner import (
    PlannedToolExposure,
    ToolExposurePlanner,
)

__all__ = ["PlannedToolExposure", "ToolExposurePlanner", "ToolRouter"]


def __getattr__(name: str) -> object:
    if name == "ToolRouter":
        from mycli.tools.routing.tool_router import ToolRouter

        return ToolRouter
    raise AttributeError(name)
