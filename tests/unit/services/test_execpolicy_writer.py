from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import stat

import pytest

from mycli.domain.runtime import ExecPolicyDecision
from mycli.services.execpolicy import ExecPolicyLoader
from mycli.services.execpolicy_lock import execpolicy_file_lock
from mycli.services.execpolicy_writer import ExecPolicyWriteError, ExecPolicyWriter


def _rules_file(home: Path) -> Path:
    return home / ".mycli" / "rules" / "default.rules"


def test_writer_creates_private_parseable_global_allow_rule(tmp_path: Path) -> None:
    home = tmp_path / "home"

    result = ExecPolicyWriter(home_dir=home).allow_prefix(
        ("python", "-m", "pytest")
    )

    rules_file = _rules_file(home)
    assert result.status == "created"
    assert len(result.pattern_hash) == 16
    assert rules_file.read_text(encoding="utf-8") == (
        'prefix_rule(pattern=["python", "-m", "pytest"], decision="allow")\n'
    )
    assert stat.S_IMODE(rules_file.stat().st_mode) == 0o600
    rules = ExecPolicyLoader(home_dir=home, workspace_root=tmp_path).load_user_rules()
    assert rules.rules[0].decision is ExecPolicyDecision.ALLOW


def test_writer_preserves_comments_and_repairs_missing_final_newline(tmp_path: Path) -> None:
    home = tmp_path / "home"
    rules_file = _rules_file(home)
    rules_file.parent.mkdir(parents=True)
    rules_file.write_text(
        '# managed by user\nprefix_rule(pattern=["uv"], decision="ask")',
        encoding="utf-8",
    )

    ExecPolicyWriter(home_dir=home).allow_prefix(("cargo", "test"))

    assert rules_file.read_text(encoding="utf-8") == (
        '# managed by user\n'
        'prefix_rule(pattern=["uv"], decision="ask")\n'
        'prefix_rule(pattern=["cargo", "test"], decision="allow")\n'
    )


def test_writer_json_escapes_tokens(tmp_path: Path) -> None:
    home = tmp_path / "home"

    ExecPolicyWriter(home_dir=home).allow_prefix(("tool", 'quote"value', "line\nbreak"))

    text = _rules_file(home).read_text(encoding="utf-8")
    assert 'quote\\"value' in text
    assert 'line\\nbreak' in text
    rules = ExecPolicyLoader(home_dir=home, workspace_root=tmp_path).load_user_rules()
    assert rules.rules[0].pattern == ("tool", 'quote"value', "line\nbreak")


def test_writer_deduplicates_identical_allow_rule(tmp_path: Path) -> None:
    home = tmp_path / "home"
    writer = ExecPolicyWriter(home_dir=home)

    first = writer.allow_prefix(("python", "-m", "pytest"))
    before = _rules_file(home).read_bytes()
    second = writer.allow_prefix(("python", "-m", "pytest"))

    assert first.status == "created"
    assert second.status == "existing"
    assert second.pattern_hash == first.pattern_hash
    assert _rules_file(home).read_bytes() == before


def test_writer_rejects_malformed_existing_rules_without_modifying_file(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    rules_file = _rules_file(home)
    rules_file.parent.mkdir(parents=True)
    original = b"not_a_rule(\n"
    rules_file.write_bytes(original)

    with pytest.raises(ExecPolicyWriteError):
        ExecPolicyWriter(home_dir=home).allow_prefix(("cargo", "test"))

    assert rules_file.read_bytes() == original


def test_writer_replace_failure_leaves_original_parseable_and_removes_temp_file(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    rules_file = _rules_file(home)
    rules_file.parent.mkdir(parents=True)
    original = 'prefix_rule(pattern=["uv"], decision="ask")\n'.encode()
    rules_file.write_bytes(original)

    def fail_replace(_source: Path, _target: Path) -> None:
        raise OSError("replace failed")

    with pytest.raises(ExecPolicyWriteError):
        ExecPolicyWriter(home_dir=home, replace_file=fail_replace).allow_prefix(
            ("cargo", "test")
        )

    assert rules_file.read_bytes() == original
    assert list(rules_file.parent.glob(".default.rules.*.tmp")) == []
    assert len(
        ExecPolicyLoader(home_dir=home, workspace_root=tmp_path).load_user_rules().rules
    ) == 1


def test_writer_serializes_concurrent_writers_without_lost_updates(tmp_path: Path) -> None:
    home = tmp_path / "home"
    patterns = (("cargo", "test"), ("python", "-m", "pytest"))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = tuple(pool.map(ExecPolicyWriter(home_dir=home).allow_prefix, patterns))

    assert {result.status for result in results} == {"created"}
    rules = ExecPolicyLoader(home_dir=home, workspace_root=tmp_path).load_user_rules()
    assert {rule.pattern for rule in rules.rules} == set(patterns)


@pytest.mark.parametrize("os_name", ["posix", "nt"])
def test_lock_dispatches_platform_operations_on_dedicated_file(
    tmp_path: Path,
    os_name: str,
) -> None:
    events: list[str] = []

    def posix_lock(_handle) -> None:
        events.append("posix_lock")

    def posix_unlock(_handle) -> None:
        events.append("posix_unlock")

    def windows_lock(_handle) -> None:
        events.append("windows_lock")

    def windows_unlock(_handle) -> None:
        events.append("windows_unlock")

    lock_file = tmp_path / "default.rules.lock"
    with execpolicy_file_lock(
        lock_file,
        os_name=os_name,
        posix_lock=posix_lock,
        posix_unlock=posix_unlock,
        windows_lock=windows_lock,
        windows_unlock=windows_unlock,
    ):
        events.append("inside")

    expected_platform = "windows" if os_name == "nt" else "posix"
    assert events == [f"{expected_platform}_lock", "inside", f"{expected_platform}_unlock"]
    assert lock_file.exists()
