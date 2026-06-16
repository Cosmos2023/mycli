from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def default_auth_path(home_dir: Path) -> Path:
    return home_dir / ".mycli" / "auth.json"


class AuthStore:
    def __init__(self, path: Path) -> None:
        self._path = path

    @property
    def path(self) -> Path:
        return self._path

    @classmethod
    def from_home(cls, home_dir: Path) -> AuthStore:
        return cls(default_auth_path(home_dir))

    def get_api_key(self, provider: str) -> str | None:
        credential = self._read().get(provider)
        if not isinstance(credential, dict):
            return None
        if credential.get("type") != "api_key":
            return None
        key = credential.get("key")
        if not isinstance(key, str):
            return None
        stripped = key.strip()
        return stripped or None

    def set_api_key(self, provider: str, api_key: str) -> None:
        payload = self._read()
        payload[provider] = {"type": "api_key", "key": api_key}
        self._write(payload)

    def _read(self) -> dict[str, Any]:
        if not self._path.exists():
            return {}
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _write(self, payload: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._path.parent.chmod(0o700)
        self._path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        self._path.chmod(0o600)


__all__ = ["AuthStore", "default_auth_path"]
