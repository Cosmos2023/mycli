from __future__ import annotations

import tomllib
from collections.abc import Iterable
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
    source_path: str = ""
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
            ("user", self._home_dir / ".mycli" / "agents"),
            ("repo", self._workspace_root / ".mycli" / "subagents"),
            ("repo", self._workspace_root / ".mycli" / "agents"),
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
    return tuple(sorted(path for path in root.iterdir() if path.is_file() and path.suffix in {".toml", ".md"}))


def _parse_profile_file(path: Path, *, source: str) -> SubAgentProfileRecord:
    if path.suffix == ".md":
        return _parse_markdown_profile_file(path, source=source)
    if path.suffix == ".toml":
        return _parse_toml_profile_file(path, source=source)
    issue = SubAgentProfileIssue(path.stem, source, path, f"unsupported profile file type: {path.suffix}")
    return SubAgentProfileRecord(path.stem, None, source, path, False, source_path=str(path), issues=(issue,))


def _parse_toml_profile_file(path: Path, *, source: str) -> SubAgentProfileRecord:
    profile_id = path.stem
    try:
        with path.open("rb") as handle:
            payload = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        issue = SubAgentProfileIssue(profile_id, source, path, f"not parseable: {exc.__class__.__name__}")
        return SubAgentProfileRecord(profile_id, None, source, path, False, source_path=str(path), issues=(issue,))
    if not isinstance(payload, dict):
        issue = SubAgentProfileIssue(profile_id, source, path, "root must be a TOML table")
        return SubAgentProfileRecord(profile_id, None, source, path, False, source_path=str(path), issues=(issue,))
    return _profile_record_from_payload(
        payload,
        path=path,
        source=source,
        fallback_profile_id=profile_id,
        system_prompt_keys=("system_prompt", "instruction"),
        allowed_tool_keys=("allowed_tools",),
        denied_tool_keys=("denied_tools",),
        budget_payload=payload.get("budget"),
    )


def _parse_markdown_profile_file(path: Path, *, source: str) -> SubAgentProfileRecord:
    profile_id = path.stem
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        issue = SubAgentProfileIssue(profile_id, source, path, f"not readable: {exc.__class__.__name__}")
        return SubAgentProfileRecord(profile_id, None, source, path, False, source_path=str(path), issues=(issue,))
    frontmatter, body, parse_issues = _parse_markdown_frontmatter(raw)
    if parse_issues:
        issues = tuple(SubAgentProfileIssue(profile_id, source, path, issue) for issue in parse_issues)
        return SubAgentProfileRecord(profile_id, None, source, path, False, source_path=str(path), issues=issues)
    payload = dict(frontmatter)
    payload["system_prompt"] = body.strip()
    return _profile_record_from_payload(
        payload,
        path=path,
        source=source,
        fallback_profile_id=profile_id,
        system_prompt_keys=("system_prompt",),
        allowed_tool_keys=("tools", "allowed_tools", "allowedTools"),
        denied_tool_keys=("disallowedTools", "denied_tools", "deniedTools"),
        budget_payload=_markdown_budget_payload(payload),
        require_name=True,
        require_description=True,
    )


def _profile_record_from_payload(
    payload: dict[str, object],
    *,
    path: Path,
    source: str,
    fallback_profile_id: str,
    system_prompt_keys: tuple[str, ...],
    allowed_tool_keys: tuple[str, ...],
    denied_tool_keys: tuple[str, ...],
    budget_payload: object,
    require_name: bool = False,
    require_description: bool = False,
) -> SubAgentProfileRecord:
    profile_id = fallback_profile_id
    raw_id = payload.get("id") or payload.get("name") or profile_id
    if require_name and not (payload.get("id") or payload.get("name")):
        issue = SubAgentProfileIssue(profile_id, source, path, "name is required")
        return SubAgentProfileRecord(profile_id, None, source, path, False, source_path=str(path), issues=(issue,))
    if not isinstance(raw_id, str) or not raw_id.strip():
        issue = SubAgentProfileIssue(profile_id, source, path, "id/name must be a non-empty string")
        return SubAgentProfileRecord(profile_id, None, source, path, False, source_path=str(path), issues=(issue,))
    profile_id = raw_id.strip()
    enabled = _optional_bool(payload.get("enabled"), default=True)
    description = _optional_string(payload.get("description"))
    system_prompt = _first_optional_string(payload, system_prompt_keys)
    allowed_tools = _first_string_tuple(payload, allowed_tool_keys) or DEFAULT_SAFE_TOOLS
    denied_tools = _first_string_tuple(payload, denied_tool_keys)
    issues: list[SubAgentProfileIssue] = []
    if enabled is None:
        enabled = False
        issues.append(SubAgentProfileIssue(profile_id, source, path, "enabled must be boolean"))
    if require_description and not description:
        issues.append(SubAgentProfileIssue(profile_id, source, path, "description is required"))
    if not system_prompt:
        issues.append(SubAgentProfileIssue(profile_id, source, path, "instruction or system_prompt is required"))
    if not allowed_tools:
        issues.append(SubAgentProfileIssue(profile_id, source, path, "allowed_tools must include at least one tool"))
    budget, budget_issues = _parse_budget(budget_payload, profile_id=profile_id, source=source, path=path)
    issues.extend(budget_issues)
    if issues:
        return SubAgentProfileRecord(
            profile_id,
            None,
            source,
            path,
            False,
            description=description,
            source_path=str(path),
            issues=tuple(issues),
        )
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
        source_path=str(path),
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
    if isinstance(value, str):
        return tuple(
            dict.fromkeys(
                item.strip().strip("\"'")
                for item in value.split(",")
                if item.strip().strip("\"'")
            )
        )
    if isinstance(value, list):
        return tuple(dict.fromkeys(item.strip() for item in value if isinstance(item, str) and item.strip()))
    if isinstance(value, tuple):
        return tuple(dict.fromkeys(item.strip() for item in value if isinstance(item, str) and item.strip()))
    return ()


def _optional_bool(value: object, *, default: bool) -> bool | None:
    if value is None:
        return default
    return value if isinstance(value, bool) else None


def _first_optional_string(payload: dict[str, object], keys: Iterable[str]) -> str:
    for key in keys:
        value = _optional_string(payload.get(key))
        if value:
            return value
    return ""


def _first_string_tuple(payload: dict[str, object], keys: Iterable[str]) -> tuple[str, ...]:
    for key in keys:
        value = _string_tuple(payload.get(key))
        if value:
            return value
    return ()


def _parse_markdown_frontmatter(raw: str) -> tuple[dict[str, object], str, tuple[str, ...]]:
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, raw, ("frontmatter is required",)
    end_index = next((index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"), None)
    if end_index is None:
        return {}, raw, ("frontmatter closing marker is required",)
    issues: list[str] = []
    payload: dict[str, object] = {}
    for line in lines[1:end_index]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in stripped:
            issues.append(f"frontmatter line is not key/value: {stripped[:48]}")
            continue
        key, raw_value = stripped.split(":", 1)
        key = key.strip()
        if not key:
            issues.append("frontmatter key cannot be blank")
            continue
        payload[key] = _parse_frontmatter_value(raw_value.strip())
    body = "\n".join(lines[end_index + 1 :])
    return payload, body, tuple(issues)


def _parse_frontmatter_value(value: str) -> object:
    if not value:
        return ""
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if value.isdecimal():
        return int(value)
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [item.strip().strip("\"'") for item in inner.split(",") if item.strip().strip("\"'")]
    return value.strip().strip("\"'")


def _markdown_budget_payload(payload: dict[str, object]) -> dict[str, object]:
    budget_keys = {
        "maxTurns": "max_turns",
        "max_turns": "max_turns",
        "maxToolCalls": "max_tool_calls",
        "max_tool_calls": "max_tool_calls",
        "noProgressTurnLimit": "no_progress_turn_limit",
        "no_progress_turn_limit": "no_progress_turn_limit",
        "reportCharLimit": "report_char_limit",
        "report_char_limit": "report_char_limit",
        "maxConcurrentBackgroundTasks": "max_concurrent_background_tasks",
        "max_concurrent_background_tasks": "max_concurrent_background_tasks",
    }
    return {target: payload[source] for source, target in budget_keys.items() if source in payload}
