from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from mycli.domain.runtime import (
    ExecPolicyDecision,
    ExecPolicyRule,
    ExecPolicyRuleSet,
    ExecPolicySource,
)


class ExecPolicyLoadError(ValueError):
    pass


class ExecPolicyRefreshError(RuntimeError):
    pass


@dataclass(slots=True, frozen=True)
class ExecPolicyLoader:
    home_dir: Path
    workspace_root: Path

    def load(self) -> ExecPolicyRuleSet:
        rules = list(self.load_user_rules().rules)
        rules.extend(
            _parse_rules_file(
                self.workspace_root / ".mycli" / "rules" / "default.rules",
                source=ExecPolicySource.PROJECT,
            )
        )
        return ExecPolicyRuleSet(rules=tuple(rules))

    def load_user_rules(self) -> ExecPolicyRuleSet:
        return ExecPolicyRuleSet(
            rules=_parse_rules_file(
                self.home_dir / ".mycli" / "rules" / "default.rules",
                source=ExecPolicySource.USER,
            )
        )


def _parse_rules_file(path: Path, *, source: ExecPolicySource) -> tuple[ExecPolicyRule, ...]:
    if not path.exists():
        return ()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ExecPolicyLoadError(f"Cannot read execpolicy rules: {path.name}") from exc

    rules: list[ExecPolicyRule] = []
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        rules.append(
            _parse_prefix_rule(
                stripped,
                source=source,
                index=len(rules),
                line_number=line_number,
                path=path,
            )
        )
    return tuple(rules)


def _parse_prefix_rule(
    line: str,
    *,
    source: ExecPolicySource,
    index: int,
    line_number: int,
    path: Path,
) -> ExecPolicyRule:
    try:
        expression = ast.parse(line, mode="eval")
    except SyntaxError as exc:
        raise ExecPolicyLoadError(_error(path, line_number, "invalid syntax")) from exc
    body = expression.body
    if not isinstance(body, ast.Call):
        raise ExecPolicyLoadError(_error(path, line_number, "expected prefix_rule(...)"))
    if not isinstance(body.func, ast.Name) or body.func.id != "prefix_rule":
        raise ExecPolicyLoadError(_error(path, line_number, "expected prefix_rule(...)"))
    if body.args:
        raise ExecPolicyLoadError(_error(path, line_number, "positional args are not supported"))

    values: dict[str, object] = {}
    for keyword in body.keywords:
        if keyword.arg not in {"pattern", "decision"}:
            raise ExecPolicyLoadError(
                _error(path, line_number, f"unsupported keyword {keyword.arg!r}")
            )
        try:
            values[keyword.arg] = ast.literal_eval(keyword.value)
        except (ValueError, TypeError) as exc:
            raise ExecPolicyLoadError(
                _error(path, line_number, f"invalid {keyword.arg}")
            ) from exc

    pattern = values.get("pattern")
    decision = values.get("decision")
    if not isinstance(pattern, list) or not all(isinstance(item, str) for item in pattern):
        raise ExecPolicyLoadError(_error(path, line_number, "pattern must be a string list"))
    if not isinstance(decision, str):
        raise ExecPolicyLoadError(_error(path, line_number, "decision must be a string"))
    try:
        parsed_decision = ExecPolicyDecision(decision)
    except ValueError as exc:
        raise ExecPolicyLoadError(_error(path, line_number, "unsupported decision")) from exc

    try:
        return ExecPolicyRule(
            source=source,
            index=index,
            pattern=tuple(pattern),
            decision=parsed_decision,
        )
    except ValueError as exc:
        raise ExecPolicyLoadError(_error(path, line_number, str(exc))) from exc


def _error(path: Path, line_number: int, message: str) -> str:
    return f"{path.name}:{line_number}: {message}"
