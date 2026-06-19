from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import getpass
from pathlib import Path
import tomllib

from mycli.config.auth_store import AuthStore
from mycli.config.settings import default_user_config_path
from mycli.domain.providers import ProviderId, parse_provider
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

    config_path = default_user_config_path(home_dir)
    _write_user_config(
        config_path,
        provider=provider,
        protocol=profile.default_protocol.value,
        model=model,
        api_base_url=api_base_url,
    )
    auth_store.set_api_key(provider.value, api_key)
    output_func("")
    output_func(f"Saved configuration to {config_path}")
    output_func(f"Saved API key to {auth_store.path}")
    _prepare_ripgrep(home_dir=home_dir, output_func=output_func)
    output_func("Run `mycli doctor` if you want to verify the provider connection.")
    return SetupResult(
        config_path=config_path,
        provider=provider,
        model=model,
        api_base_url=api_base_url,
    )


def _prepare_ripgrep(*, home_dir: Path, output_func: OutputFunc) -> None:
    try:
        result = prepare_user_ripgrep(
            dest_root=home_dir / ".mycli" / "vendor" / "ripgrep",
        )
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
    payload = {
        **existing,
        "provider": provider.value,
        "protocol": protocol,
        "model": model,
        "api_base_url": api_base_url.rstrip("/"),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_format_toml(payload), encoding="utf-8")
    path.chmod(0o600)


def _read_toml(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    with path.open("rb") as handle:
        return tomllib.load(handle)


def _format_toml(payload: dict[str, object]) -> str:
    preferred_order = ("provider", "protocol", "model", "api_base_url")
    lines: list[str] = []
    emitted: set[str] = set()
    for key in preferred_order:
        if key in payload and not isinstance(payload[key], dict):
            lines.append(_format_toml_item(key, payload[key]))
            emitted.add(key)
    for key in sorted(payload):
        if key in emitted:
            continue
        value = payload[key]
        if not isinstance(value, dict):
            lines.append(_format_toml_item(key, value))
            emitted.add(key)
    for key in sorted(payload):
        if key in emitted:
            continue
        value = payload[key]
        if isinstance(value, dict):
            lines.extend(_format_toml_table((key,), value))
    return "\n".join(lines) + "\n"


def _format_toml_item(key: str, value: object) -> str:
    return f"{key} = {_format_toml_value(value)}"


def _format_toml_value(value: object) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(_format_toml_value(item) for item in value) + "]"
    return f'"{_escape_toml_string(str(value))}"'


def _format_toml_table(path: tuple[str, ...], payload: dict[str, object]) -> list[str]:
    scalar_lines: list[str] = []
    nested_tables: list[tuple[str, dict[str, object]]] = []
    for key in sorted(payload):
        value = payload[key]
        if isinstance(value, dict):
            nested_tables.append((key, value))
        else:
            scalar_lines.append(_format_toml_item(key, value))

    lines: list[str] = []
    if scalar_lines:
        lines.append("")
        lines.append(f"[{'.'.join(path)}]")
        lines.extend(scalar_lines)
    for key, value in nested_tables:
        lines.extend(_format_toml_table((*path, key), value))
    return lines


def _escape_toml_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


__all__ = [
    "SetupResult",
    "default_user_config_path",
    "run_setup_wizard",
]
