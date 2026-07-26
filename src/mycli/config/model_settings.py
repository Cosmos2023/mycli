from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tomllib

from mycli.config.file_permissions import harden_private_path
from mycli.config.settings import default_user_config_path
from mycli.config.toml_format import flatten_user_config_payload, format_user_config_toml
from mycli.domain.runtime import AgentConfig


@dataclass(frozen=True, slots=True)
class ModelSettingsSnapshot:
    path: Path
    existed: bool
    content: bytes

    def restore(self) -> None:
        if not self.existed:
            self.path.unlink(missing_ok=True)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path.write_bytes(self.content)
        harden_private_path(self.path.parent, mode=0o700)
        harden_private_path(self.path, mode=0o600)


def save_model_settings(home_dir: Path, config: AgentConfig) -> ModelSettingsSnapshot:
    path = default_user_config_path(home_dir)
    existed = path.exists()
    content = path.read_bytes() if existed else b""
    payload = _read_payload(path)
    payload.update(
        {
            "provider": config.provider.value,
            "protocol": config.protocol.value,
            "model": config.model,
            "api_base_url": config.api_base_url,
            "auth_ref": config.auth_ref or config.provider.value,
            "supports_images": config.supports_images,
            "thinking_enabled": config.thinking_enabled,
            "reasoning_effort": config.reasoning_effort.value,
        }
    )
    if config.thinking_effort is None:
        payload.pop("thinking_effort", None)
    else:
        payload["thinking_effort"] = config.thinking_effort.value
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(format_user_config_toml(payload), encoding="utf-8")
    harden_private_path(path.parent, mode=0o700)
    harden_private_path(path, mode=0o600)
    return ModelSettingsSnapshot(path=path, existed=existed, content=content)


def _read_payload(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        with path.open("rb") as handle:
            return flatten_user_config_payload(tomllib.load(handle))
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"Invalid TOML in {path}: {exc}") from exc
    except OSError as exc:
        raise ValueError(f"Could not read configuration file {path}: {exc}") from exc


__all__ = ["ModelSettingsSnapshot", "save_model_settings"]
