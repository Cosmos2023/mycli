from __future__ import annotations

from pathlib import Path
import stat

from mycli.tools import ripgrep_runtime
from mycli.tools.ripgrep_prepare import (
    default_user_ripgrep_root,
    prepare_user_ripgrep,
    ripgrep_output_path,
)


def test_prepend_ripgrep_to_path_prefers_prepared_binary(
    monkeypatch,
    tmp_path: Path,
) -> None:
    rg = tmp_path / "rg-bin" / "rg"
    rg.parent.mkdir()
    rg.write_text("#!/bin/sh\n", encoding="utf-8")
    rg.chmod(rg.stat().st_mode | stat.S_IXUSR)

    monkeypatch.setattr(ripgrep_runtime, "ripgrep_candidates", lambda: (rg,))

    path, path_dir = ripgrep_runtime.prepend_ripgrep_to_path("/usr/bin")

    assert path_dir == str(rg.parent)
    assert path.split(":")[:2] == [str(rg.parent), "/usr/bin"]


def test_prepend_ripgrep_to_path_falls_back_to_existing_path(
    monkeypatch,
) -> None:
    monkeypatch.setattr(ripgrep_runtime, "ripgrep_candidates", lambda: ())
    monkeypatch.setattr(ripgrep_runtime.shutil, "which", lambda name: None)

    path, path_dir = ripgrep_runtime.prepend_ripgrep_to_path("/usr/bin")

    assert path == "/usr/bin"
    assert path_dir is None


def test_prepare_user_ripgrep_defaults_to_user_vendor(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    assert default_user_ripgrep_root() == tmp_path / ".mycli" / "vendor" / "ripgrep"


def test_prepare_user_ripgrep_reuses_existing_user_vendor_binary(tmp_path: Path) -> None:
    dest_root = tmp_path / ".mycli" / "vendor" / "ripgrep"
    output_path = ripgrep_output_path(target="macos-aarch64", dest_root=dest_root)
    output_path.parent.mkdir(parents=True)
    output_path.write_text("#!/bin/sh\n", encoding="utf-8")
    output_path.chmod(output_path.stat().st_mode | stat.S_IXUSR)

    result = prepare_user_ripgrep(target="macos-aarch64", dest_root=dest_root)

    assert result.path == output_path
    assert result.installed is False
