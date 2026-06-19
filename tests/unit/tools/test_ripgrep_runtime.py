from __future__ import annotations

from pathlib import Path
import stat

from mycli.tools import ripgrep_runtime


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
