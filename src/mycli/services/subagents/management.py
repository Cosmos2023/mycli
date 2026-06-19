from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from mycli.services.subagents.diagnostics import diagnostics_from_discovery
from mycli.services.subagents.registry import SubAgentProfileRecord, SubAgentProfileRegistry


@dataclass(slots=True, frozen=True)
class SubAgentManagementRow:
    profile_id: str
    source: str
    source_path: str
    description: str
    enabled: bool
    status: str
    allowed_tools: tuple[str, ...]
    denied_tools: tuple[str, ...]
    high_risk_tools: tuple[str, ...]
    model: str | None
    issues: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "profile_id": self.profile_id,
            "source": self.source,
            "source_path": self.source_path,
            "description": self.description,
            "enabled": self.enabled,
            "status": self.status,
            "allowed_tools": list(self.allowed_tools),
            "denied_tools": list(self.denied_tools),
            "high_risk_tools": list(self.high_risk_tools),
            "model": self.model,
            "issues": list(self.issues),
        }


@dataclass(slots=True, frozen=True)
class SubAgentManagementResponse:
    ok: bool
    action: str
    message: str
    profiles: tuple[SubAgentManagementRow, ...] = ()
    profile: SubAgentManagementRow | None = None
    issues: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "ok": self.ok,
            "action": self.action,
            "message": self.message,
            "profiles": [row.to_dict() for row in self.profiles],
            "issues": list(self.issues),
        }
        if self.profile is not None:
            payload["profile"] = self.profile.to_dict()
        return payload


class SubAgentManagementService:
    def __init__(self, *, workspace_root: Path, home_dir: Path, known_tools: Iterable[str] = ()) -> None:
        self._workspace_root = workspace_root
        self._home_dir = home_dir
        self._known_tools = tuple(known_tools)

    def list_profiles(self) -> SubAgentManagementResponse:
        discovery = SubAgentProfileRegistry(workspace_root=self._workspace_root, home_dir=self._home_dir).discover()
        diagnostics = diagnostics_from_discovery(discovery, known_tools=self._known_tools)
        rows = tuple(_row_for(record) for record in discovery.records)
        return SubAgentManagementResponse(
            ok=diagnostics.issue_count == 0,
            action="list",
            message=(
                f"subagents: {diagnostics.profile_count} profiles, "
                f"{diagnostics.available_count} enabled, {diagnostics.disabled_count} disabled"
            ),
            profiles=rows,
            issues=diagnostics.issues,
        )

    def inspect_profile(self, profile_id: str) -> SubAgentManagementResponse:
        discovery = SubAgentProfileRegistry(workspace_root=self._workspace_root, home_dir=self._home_dir).discover()
        diagnostics = diagnostics_from_discovery(discovery, known_tools=self._known_tools)
        rows = tuple(_row_for(record) for record in discovery.records)
        row = next((item for item in rows if item.profile_id == profile_id), None)
        if row is None:
            return SubAgentManagementResponse(
                ok=False,
                action="inspect",
                message=f"subagent profile not found: {profile_id}",
                profiles=rows,
                issues=diagnostics.issues,
            )
        return SubAgentManagementResponse(
            ok=not row.issues,
            action="inspect",
            message=f"subagent profile: {profile_id}",
            profile=row,
            profiles=(row,),
            issues=diagnostics.issues,
        )


def _row_for(record: SubAgentProfileRecord) -> SubAgentManagementRow:
    profile = record.profile
    return SubAgentManagementRow(
        profile_id=record.profile_id,
        source=record.source,
        source_path=record.source_path,
        description=record.description,
        enabled=record.enabled,
        status=record.status,
        allowed_tools=record.allowed_tools,
        denied_tools=record.denied_tools,
        high_risk_tools=record.high_risk_tools,
        model=profile.model if profile is not None else None,
        issues=tuple(issue.safe_line() for issue in record.issues),
    )


def render_subagent_management_response(response: SubAgentManagementResponse) -> tuple[str, ...]:
    lines = [f"mycli subagents {response.action}: {response.message}"]
    rows = response.profiles or ((response.profile,) if response.profile is not None else ())
    for row in rows:
        if row is not None:
            lines.extend(_render_subagent_row(row))
    for issue in response.issues:
        lines.append(f"subagent_issue: {issue}")
    return tuple(lines)


def _render_subagent_row(row: SubAgentManagementRow) -> tuple[str, ...]:
    allowed = ",".join(row.allowed_tools) if row.allowed_tools else "none"
    denied = ",".join(row.denied_tools) if row.denied_tools else "none"
    high_risk = ",".join(row.high_risk_tools) if row.high_risk_tools else "none"
    lines = [
        f"subagent {row.profile_id}",
        f"  source={row.source} enabled={str(row.enabled).lower()} status={row.status}",
        f"  path={row.source_path or 'builtin'}",
        f"  description={row.description or 'none'}",
        f"  allowed_tools={allowed}",
        f"  denied_tools={denied}",
        f"  high_risk_tools={high_risk} model={row.model or 'inherit'}",
    ]
    lines.extend(f"  issue={issue}" for issue in row.issues)
    return tuple(lines)
