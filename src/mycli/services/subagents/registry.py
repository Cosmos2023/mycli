from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from mycli.domain.subagent_profiles import list_sub_agent_profiles
from mycli.domain.subagents import SubAgentBudget, SubAgentProfile

HIGH_RISK_SUBAGENT_TOOLS = frozenset({"Bash", "Write", "Edit", "Patch"})
DEFAULT_SAFE_TOOLS = ("Read", "Grep", "Glob", "LS")


@dataclass(slots=True, frozen=True)
class SubAgentProfileIssue:
    profile_id: str
    source: str
    path: Path | None
    message: str

    def safe_line(self) -> str:
        path_name = self.path.name if self.path is not None else "builtin"
        return f"{self.source}:{path_name}:{self.profile_id}: {self.message}"


@dataclass(slots=True, frozen=True)
class SubAgentProfileRecord:
    profile_id: str
    profile: SubAgentProfile | None
    source: str
    path: Path | None
    enabled: bool
    description: str = ""
    issues: tuple[SubAgentProfileIssue, ...] = ()

    @property
    def status(self) -> str:
        if self.issues:
            return "failed"
        return "enabled" if self.enabled else "disabled"

    @property
    def allowed_tools(self) -> tuple[str, ...]:
        if self.profile is None:
            return ()
        return self.profile.default_tools

    @property
    def denied_tools(self) -> tuple[str, ...]:
        if self.profile is None:
            return ()
        return self.profile.denied_tools

    @property
    def high_risk_tools(self) -> tuple[str, ...]:
        return tuple(tool for tool in self.allowed_tools if tool in HIGH_RISK_SUBAGENT_TOOLS)


@dataclass(slots=True, frozen=True)
class SubAgentProfileDiscovery:
    records: tuple[SubAgentProfileRecord, ...]
    issues: tuple[SubAgentProfileIssue, ...]

    @property
    def enabled_records(self) -> tuple[SubAgentProfileRecord, ...]:
        return tuple(record for record in self.records if record.enabled and not record.issues)

    @property
    def enabled_count(self) -> int:
        return len(self.enabled_records)

    @property
    def disabled_count(self) -> int:
        return sum(1 for record in self.records if not record.enabled and not record.issues)

    def get_enabled_profile(self, profile_id: str) -> SubAgentProfile | None:
        for record in self.enabled_records:
            if record.profile_id == profile_id:
                return record.profile
        return None

    def list_enabled_profiles(self) -> tuple[SubAgentProfile, ...]:
        return tuple(record.profile for record in self.enabled_records if record.profile is not None)


class SubAgentProfileRegistry:
    def __init__(self, *, workspace_root: Path, home_dir: Path) -> None:
        self._workspace_root = workspace_root
        self._home_dir = home_dir

    def discover(self) -> SubAgentProfileDiscovery:
        records_by_id: dict[str, SubAgentProfileRecord] = {
            profile.name: SubAgentProfileRecord(
                profile_id=profile.name,
                profile=profile,
                source="builtin",
                path=None,
                enabled=True,
                description=profile.system_prompt,
            )
            for profile in list_sub_agent_profiles()
        }
        issues: list[SubAgentProfileIssue] = []
        for source, root in (
            ("user", self._home_dir / ".mycli" / "subagents"),
            ("repo", self._workspace_root / ".mycli" / "subagents"),
        ):
            for path in _profile_files(root):
                record = _parse_profile_file(path, source=source)
                records_by_id[record.profile_id] = record
                issues.extend(record.issues)
        return SubAgentProfileDiscovery(
            records=tuple(records_by_id[key] for key in sorted(records_by_id)),
            issues=tuple(issues),
        )

    def get_profile(self, profile_id: str) -> SubAgentProfile | None:
        return self.discover().get_enabled_profile(profile_id)

    def list_profiles(self) -> tuple[SubAgentProfile, ...]:
        return self.discover().list_enabled_profiles()


def _profile_files(root: Path) -> tuple[Path, ...]:
    if not root.exists() or not root.is_dir():
        return ()
    return tuple(sorted(path for path in root.glob("*.toml") if path.is_file()))


def _parse_profile_file(path: Path, *, source: str) -> SubAgentProfileRecord:
    profile_id = path.stem
    try:
        with path.open("rb") as handle:
            payload = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        issue = SubAgentProfileIssue(profile_id, source, path, f"not parseable: {exc.__class__.__name__}")
        return SubAgentProfileRecord(profile_id, None, source, path, False, issues=(issue,))
    if not isinstance(payload, dict):
        issue = SubAgentProfileIssue(profile_id, source, path, "root must be a TOML table")
        return SubAgentProfileRecord(profile_id, None, source, path, False, issues=(issue,))
    raw_id = payload.get("id") or payload.get("name") or profile_id
    if not isinstance(raw_id, str) or not raw_id.strip():
        issue = SubAgentProfileIssue(profile_id, source, path, "id/name must be a non-empty string")
        return SubAgentProfileRecord(profile_id, None, source, path, False, issues=(issue,))
    profile_id = raw_id.strip()
    enabled = _optional_bool(payload.get("enabled"), default=True)
    description = _optional_string(payload.get("description"))
    system_prompt = _optional_string(payload.get("system_prompt")) or _optional_string(payload.get("instruction"))
    allowed_tools = _string_tuple(payload.get("allowed_tools")) or DEFAULT_SAFE_TOOLS
    denied_tools = _string_tuple(payload.get("denied_tools"))
    issues: list[SubAgentProfileIssue] = []
    if enabled is None:
        enabled = False
        issues.append(SubAgentProfileIssue(profile_id, source, path, "enabled must be boolean"))
    if not system_prompt:
        issues.append(SubAgentProfileIssue(profile_id, source, path, "instruction or system_prompt is required"))
    if not allowed_tools:
        issues.append(SubAgentProfileIssue(profile_id, source, path, "allowed_tools must include at least one tool"))
    budget, budget_issues = _parse_budget(payload.get("budget"), profile_id=profile_id, source=source, path=path)
    issues.extend(budget_issues)
    if issues:
        return SubAgentProfileRecord(profile_id, None, source, path, False, description=description, issues=tuple(issues))
    assert enabled is not None
    assert system_prompt is not None
    profile = SubAgentProfile(
        name=profile_id,
        system_prompt=system_prompt,
        default_tools=allowed_tools,
        denied_tools=denied_tools,
        budget=budget,
        model=_optional_string(payload.get("model")),
    )
    return SubAgentProfileRecord(
        profile_id=profile_id,
        profile=profile,
        source=source,
        path=path,
        enabled=enabled,
        description=description,
    )


def _parse_budget(
    value: object,
    *,
    profile_id: str,
    source: str,
    path: Path,
) -> tuple[SubAgentBudget, tuple[SubAgentProfileIssue, ...]]:
    if value is None:
        return SubAgentBudget(), ()
    if not isinstance(value, dict):
        return SubAgentBudget(), (SubAgentProfileIssue(profile_id, source, path, "budget must be a table"),)
    kwargs: dict[str, int] = {}
    issues: list[SubAgentProfileIssue] = []
    for field_name in (
        "max_turns",
        "max_tool_calls",
        "no_progress_turn_limit",
        "report_char_limit",
        "max_concurrent_background_tasks",
    ):
        raw = value.get(field_name)
        if raw is None:
            continue
        if isinstance(raw, bool) or not isinstance(raw, int):
            issues.append(SubAgentProfileIssue(profile_id, source, path, f"budget.{field_name} must be integer"))
            continue
        kwargs[field_name] = raw
    if issues:
        return SubAgentBudget(), tuple(issues)
    try:
        return SubAgentBudget(**kwargs), ()
    except ValueError as exc:
        return SubAgentBudget(), (SubAgentProfileIssue(profile_id, source, path, str(exc)),)


def _optional_string(value: object) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _string_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(dict.fromkeys(item.strip() for item in value if isinstance(item, str) and item.strip()))


def _optional_bool(value: object, *, default: bool) -> bool | None:
    if value is None:
        return default
    return value if isinstance(value, bool) else None
