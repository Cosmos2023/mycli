from __future__ import annotations

import importlib.util
from pathlib import Path
import stat
from types import ModuleType

from mycli.tools import ripgrep_runtime


def _load_prepare_ripgrep() -> ModuleType:
    script = Path(__file__).resolve().parents[3] / "scripts" / "prepare_ripgrep.py"
    spec = importlib.util.spec_from_file_location("prepare_ripgrep", script)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


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


def test_package_ripgrep_candidate_precedes_user_vendor() -> None:
    package_candidate, user_candidate = ripgrep_runtime.ripgrep_candidates()

    assert "src/mycli/vendor/ripgrep" in str(package_candidate)
    assert ".mycli/vendor/ripgrep" in str(user_candidate)


def test_prepare_ripgrep_package_destination_points_at_package_vendor() -> None:
    prepare_ripgrep = _load_prepare_ripgrep()
    dest = prepare_ripgrep.resolve_dest(None, package=True)

    assert dest == Path(__file__).resolve().parents[3] / "src" / "mycli" / "vendor" / "ripgrep"
