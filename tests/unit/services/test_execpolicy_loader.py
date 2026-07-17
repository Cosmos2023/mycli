from __future__ import annotations

from pathlib import Path

import pytest

from mycli.domain.runtime import ExecPolicyDecision, ExecPolicySource
from mycli.services.execpolicy import ExecPolicyLoadError, ExecPolicyLoader


def test_execpolicy_loader_reads_user_and_project_rules_with_project_precedence(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    user_rules = home / ".mycli" / "rules"
    project_rules = workspace / ".mycli" / "rules"
    user_rules.mkdir(parents=True)
    project_rules.mkdir(parents=True)
    (user_rules / "default.rules").write_text(
        'prefix_rule(pattern=["uv", "run", "pytest"], decision="allow")\n',
        encoding="utf-8",
    )
    (project_rules / "default.rules").write_text(
        'prefix_rule(pattern=["uv", "run", "pytest"], decision="deny")\n',
        encoding="utf-8",
    )

    ruleset = ExecPolicyLoader(home_dir=home, workspace_root=workspace).load()

    match = ruleset.match(("uv", "run", "pytest", "-q"))
    assert match is not None
    assert match.rule.source is ExecPolicySource.PROJECT
    assert match.rule.decision is ExecPolicyDecision.DENY


def test_execpolicy_loader_rejects_unknown_syntax(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    project_rules = workspace / ".mycli" / "rules"
    project_rules.mkdir(parents=True)
    (project_rules / "default.rules").write_text(
        'shell_rule(command="rm -rf /", decision="deny")\n',
        encoding="utf-8",
    )

    with pytest.raises(ExecPolicyLoadError):
        ExecPolicyLoader(home_dir=home, workspace_root=workspace).load()


def test_execpolicy_loader_load_user_rules_ignores_project_rules(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    user_rules = home / ".mycli" / "rules"
    project_rules = workspace / ".mycli" / "rules"
    user_rules.mkdir(parents=True)
    project_rules.mkdir(parents=True)
    (user_rules / "default.rules").write_text(
        'prefix_rule(pattern=["python", "-m", "pytest"], decision="allow")\n',
        encoding="utf-8",
    )
    (project_rules / "default.rules").write_text(
        'prefix_rule(pattern=["python", "-m", "pytest"], decision="deny")\n',
        encoding="utf-8",
    )

    ruleset = ExecPolicyLoader(home_dir=home, workspace_root=workspace).load_user_rules()

    assert len(ruleset.rules) == 1
    assert ruleset.rules[0].source is ExecPolicySource.USER
    assert ruleset.rules[0].decision is ExecPolicyDecision.ALLOW
