from pathlib import Path
import stat

from mycli.config.shell_settings import save_shell_settings


def test_save_shell_settings_keeps_private_file_permissions(tmp_path: Path) -> None:
    settings = save_shell_settings(tmp_path, {"theme": "light"})
    path = tmp_path / ".mycli" / "config.toml"

    assert settings.theme == "light"
    rendered = path.read_text(encoding="utf-8")
    assert "[tui]" in rendered
    assert 'theme = "light"' in rendered
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
