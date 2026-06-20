from __future__ import annotations

import contextlib
from collections.abc import Callable
from dataclasses import dataclass
import getpass
import json
import os
import subprocess
import tempfile
from pathlib import Path
import tomllib

from mycli.config.auth_store import AuthStore
from mycli.config.settings import default_user_config_path
from mycli.config.toml_format import format_user_config_toml
from mycli.domain.providers import ProviderId, parse_provider
from mycli.cli.node_tui.process import NodeTuiProcessError, build_node_setup_command, check_node_version, node_tui_child_env
from mycli.infrastructure.providers import profile_for_provider
from mycli.tools.ripgrep_prepare import RIPGREP_VERSION, prepare_user_ripgrep


InputFunc = Callable[[str], str]
SecretInputFunc = Callable[[str], str]
OutputFunc = Callable[[str], object]


@dataclass(slots=True, frozen=True)
class SetupResult:
    config_path: Path
    provider: ProviderId
    model: str
    api_base_url: str


_PROVIDER_CHOICES: tuple[ProviderId, ...] = (
    ProviderId.OPENAI,
    ProviderId.CODEX,
    ProviderId.DEEPSEEK,
    ProviderId.QWEN,
    ProviderId.ANTHROPIC,
    ProviderId.COMPATIBLE,
)

_PROVIDER_DISPLAY_NAMES: dict[ProviderId, str] = {
    ProviderId.OPENAI: "OpenAI",
    ProviderId.CODEX: "Codex Responses",
    ProviderId.DEEPSEEK: "DeepSeek",
    ProviderId.QWEN: "Qwen",
    ProviderId.ANTHROPIC: "Anthropic",
    ProviderId.COMPATIBLE: "Compatible",
}

_BORDER = "────────────────────────────────────────"


def run_setup_wizard(
    *,
    home_dir: Path,
    input_func: InputFunc = input,
    secret_input_func: SecretInputFunc | None = None,
    output_func: OutputFunc = print,
) -> SetupResult:
    if input_func is input and output_func is print and _stdio_is_tty():
        with_tui = _run_node_setup_wizard(home_dir=home_dir, output_func=output_func)
        if with_tui is not None:
            return with_tui

    secret_reader = secret_input_func or getpass.getpass
    output_func("mycli setup")
    output_func("Configure a model provider for this user account.")
    output_func("")

    _prompt_auth_method(input_func=input_func, output_func=output_func)
    auth_store = AuthStore.from_home(home_dir)
    provider = _prompt_provider(
        input_func=input_func,
        output_func=output_func,
        auth_store=auth_store,
    )
    profile = profile_for_provider(provider)
    _render_panel_title(output_func, f"Login to {_provider_display_name(provider)}")
    api_base_url = _prompt_text(
        input_func=input_func,
        prompt="API base URL",
        default=profile.default_base_url,
    )
    model_default = profile.default_model or ""
    model = _prompt_text(input_func=input_func, prompt="Model", default=model_default)
    output_func("Enter API key:")
    api_key = _prompt_secret(secret_reader, "API key")
    output_func(_BORDER)

    result = _save_setup(
        home_dir=home_dir,
        provider=provider,
        protocol=profile.default_protocol.value,
        model=model,
        api_base_url=api_base_url,
        api_key=api_key,
    )
    auth_store = AuthStore.from_home(home_dir)
    output_func("")
    output_func(f"Saved configuration to {result.config_path}")
    output_func(f"Saved API key to {auth_store.path}")
    _prepare_ripgrep(home_dir=home_dir, output_func=output_func)
    output_func("Run `mycli doctor` if you want to verify the provider connection.")
    return result


def _run_node_setup_wizard(*, home_dir: Path, output_func: OutputFunc) -> SetupResult | None:
    try:
        check_node_version()
        repo_root = Path(__file__).resolve().parents[3]
        command = build_node_setup_command(repo_root=repo_root, env={})
    except NodeTuiProcessError as exc:
        output_func(f"Node setup TUI unavailable; falling back to plain setup: {exc}")
        return None
    with tempfile.NamedTemporaryFile(prefix="mycli-setup-", suffix=".json", delete=False) as handle:
        result_path = Path(handle.name)
    try:
        env = node_tui_child_env(base_env=os.environ, requested_env={})
        env["MYCLI_SETUP_STATE"] = json.dumps(_node_setup_state(home_dir))
        env["MYCLI_SETUP_RESULT_PATH"] = str(result_path)
        completed = subprocess.run(command, cwd=repo_root, env=env, check=False)
        if completed.returncode == 130:
            raise KeyboardInterrupt
        if completed.returncode != 0:
            output_func("Node setup TUI exited without saving; falling back to plain setup.")
            return None
        try:
            payload = json.loads(result_path.read_text(encoding="utf-8") or "{}")
        except (OSError, json.JSONDecodeError):
            output_func("Node setup TUI returned invalid output; falling back to plain setup.")
            return None
    finally:
        with contextlib.suppress(OSError):
            result_path.unlink()
    return _save_node_setup_payload(home_dir=home_dir, payload=payload, output_func=output_func)


def _save_node_setup_payload(*, home_dir: Path, payload: object, output_func: OutputFunc) -> SetupResult | None:
    if not isinstance(payload, dict):
        output_func("Node setup TUI returned invalid output; falling back to plain setup.")
        return None
    try:
        provider = parse_provider(str(payload["provider"]))
        api_base_url = str(payload["api_base_url"])
        model = str(payload["model"])
        api_key = str(payload["api_key"])
    except (KeyError, ValueError):
        output_func("Node setup TUI returned incomplete output; falling back to plain setup.")
        return None
    if not api_base_url.strip() or not model.strip() or not api_key.strip():
        output_func("Node setup TUI returned incomplete output; falling back to plain setup.")
        return None
    profile = profile_for_provider(provider)
    result = _save_setup(
        home_dir=home_dir,
        provider=provider,
        protocol=profile.default_protocol.value,
        model=model,
        api_base_url=api_base_url,
        api_key=api_key,
    )
    auth_store = AuthStore.from_home(home_dir)
    output_func(f"Saved configuration to {result.config_path}")
    output_func(f"Saved API key to {auth_store.path}")
    _prepare_ripgrep(home_dir=home_dir, output_func=output_func)
    output_func("Run `mycli doctor` if you want to verify the provider connection.")
    return result


def _node_setup_state(home_dir: Path) -> dict[str, object]:
    auth_store = AuthStore.from_home(home_dir)
    providers: list[dict[str, object]] = []
    for provider in _PROVIDER_CHOICES:
        profile = profile_for_provider(provider)
        providers.append(
            {
                "id": provider.value,
                "name": _provider_display_name(provider),
                "configured": bool(auth_store.get_api_key(provider.value)),
                "default_model": profile.default_model or "",
                "default_base_url": profile.default_base_url,
                "protocol": profile.default_protocol.value,
            }
        )
    return {
        "providers": providers,
        "config_path": str(default_user_config_path(home_dir)),
        "auth_path": str(auth_store.path),
    }


def _save_setup(
    *,
    home_dir: Path,
    provider: ProviderId,
    protocol: str,
    model: str,
    api_base_url: str,
    api_key: str,
) -> SetupResult:
    config_path = default_user_config_path(home_dir)
    _write_user_config(
        config_path,
        provider=provider,
        protocol=protocol,
        model=model,
        api_base_url=api_base_url,
    )
    AuthStore.from_home(home_dir).set_api_key(provider.value, api_key)
    return SetupResult(config_path=config_path, provider=provider, model=model, api_base_url=api_base_url)


def _prepare_ripgrep(*, home_dir: Path, output_func: OutputFunc) -> None:
    try:
        result = prepare_user_ripgrep(
            dest_root=home_dir / ".mycli" / "vendor" / "ripgrep",
        )
    except KeyboardInterrupt:
        output_func("Ripgrep preparation interrupted; setup changes were saved.")
        return
    except Exception as exc:
        output_func(f"Could not prepare ripgrep: {exc}")
        return
    if result.installed:
        output_func(f"Prepared ripgrep {RIPGREP_VERSION}: {result.path}")
    else:
        output_func(f"Ripgrep already prepared: {result.path}")


def _prompt_auth_method(
    *,
    input_func: InputFunc,
    output_func: OutputFunc,
) -> None:
    _render_panel_title(output_func, "Select authentication method:")
    output_func("  1. Use an API key")
    output_func(_BORDER)
    while True:
        raw = input_func("Authentication method [1]: ").strip().lower()
        if raw in {"", "1", "api_key", "api-key", "api key", "key"}:
            return
        output_func("Unsupported authentication method. Choose 1 or API key.")


def _prompt_provider(
    *,
    input_func: InputFunc,
    output_func: OutputFunc,
    auth_store: AuthStore,
) -> ProviderId:
    _render_panel_title(output_func, "Select provider to configure:")
    for index, provider in enumerate(_PROVIDER_CHOICES, start=1):
        profile = profile_for_provider(provider)
        default_model = f" · default model {profile.default_model}" if profile.default_model else ""
        output_func(f"  {index}. {_provider_display_name(provider)}{_provider_status(provider, auth_store)}{default_model}")
    output_func(_BORDER)
    while True:
        raw = input_func("Provider [1]: ").strip()
        if not raw:
            return _PROVIDER_CHOICES[0]
        if raw.isdigit():
            index = int(raw)
            if 1 <= index <= len(_PROVIDER_CHOICES):
                return _PROVIDER_CHOICES[index - 1]
        try:
            return parse_provider(raw.lower())
        except ValueError:
            allowed = ", ".join(provider.value for provider in _PROVIDER_CHOICES)
            output_func(f"Unsupported provider. Choose 1-{len(_PROVIDER_CHOICES)} or one of: {allowed}.")


def _provider_status(provider: ProviderId, auth_store: AuthStore) -> str:
    if auth_store.get_api_key(provider.value):
        return " ✓ configured"
    return " • unconfigured"


def _provider_display_name(provider: ProviderId) -> str:
    return _PROVIDER_DISPLAY_NAMES.get(provider, provider.value)


def _render_panel_title(output_func: OutputFunc, title: str) -> None:
    output_func(_BORDER)
    output_func(title)
    output_func("")


def _stdio_is_tty() -> bool:
    import sys

    return sys.stdin.isatty() and sys.stdout.isatty()


def _prompt_text(
    *,
    input_func: InputFunc,
    prompt: str,
    default: str,
) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        raw = input_func(f"{prompt}{suffix}: ").strip()
        value = raw or default
        if value:
            return value


def _prompt_secret(secret_input_func: SecretInputFunc, prompt: str) -> str:
    while True:
        value = secret_input_func(f"{prompt}: ").strip()
        if value:
            return value


def _write_user_config(
    path: Path,
    *,
    provider: ProviderId,
    protocol: str,
    model: str,
    api_base_url: str,
) -> None:
    existing = _read_toml(path)
    existing.pop("api_key", None)
    cache_capability = profile_for_provider(provider).cache_policy_capability
    payload = {
        **existing,
        "provider": provider.value,
        "protocol": protocol,
        "model": model,
        "api_base_url": api_base_url.rstrip("/"),
    }
    if cache_capability is not None:
        payload["prompt_cache_key_enabled"] = cache_capability.prompt_cache_key_enabled
        payload["cache_control_enabled"] = cache_capability.cache_control_enabled
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(format_user_config_toml(payload), encoding="utf-8")
    path.chmod(0o600)


def _read_toml(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        return tomllib.load(handle)


__all__ = [
    "SetupResult",
    "default_user_config_path",
    "run_setup_wizard",
]
