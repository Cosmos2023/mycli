from pathlib import Path
import stat

from mycli.config.file_permissions import harden_private_path


def test_harden_private_path_applies_posix_mode(tmp_path: Path) -> None:
    target = tmp_path / "secret"
    target.write_text("x", encoding="utf-8")

    harden_private_path(target, mode=0o600, os_name="posix")

    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_harden_private_path_ignores_windows_chmod_failure(tmp_path: Path) -> None:
    calls: list[int] = []

    def failing_chmod(_path: Path, mode: int) -> None:
        calls.append(mode)
        raise OSError("Windows ACL does not expose POSIX mode bits")

    harden_private_path(
        tmp_path / "secret",
        mode=0o600,
        os_name="nt",
        chmod=failing_chmod,
    )

    assert calls == [0o600]


def test_harden_private_path_reraises_posix_chmod_failure(tmp_path: Path) -> None:
    def failing_chmod(_path: Path, _mode: int) -> None:
        raise OSError("denied")

    try:
        harden_private_path(
            tmp_path / "secret",
            mode=0o600,
            os_name="posix",
            chmod=failing_chmod,
        )
    except OSError as exc:
        assert str(exc) == "denied"
    else:
        raise AssertionError("POSIX chmod failure was swallowed")
