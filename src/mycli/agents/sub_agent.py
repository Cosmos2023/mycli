"""Legacy sub-agent module.

P3 routes all sub-agent execution through
``mycli.application.runtime.subagents``. This module is intentionally kept as
a small compatibility marker while old direct users are migrated.
"""

from __future__ import annotations

from mycli.domain.subagents import SubAgentResult


SubAgentReportFragment = SubAgentResult

__all__ = ["SubAgentReportFragment"]
