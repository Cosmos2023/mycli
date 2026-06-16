from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import getpass
from pathlib import Path
import tomllib

from mycli.domain.providers import ProviderId, parse_provider
from mycli.infrastructure.providers import profile_for_provider


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
    ProviderId.DEEPSEEK,
    ProviderId.QWEN,
    ProviderId.ANTHROPIC,
    ProviderId.COMPATIBLE,
)


def default_user_config_path(home_dir: Path) -> Path:
    return home_dir / ".config" / "mycli" / "config.toml"


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

    provider = _prompt_provider(input_func=input_func, output_func=output_func)
    profile = profile_for_provider(provider)
    api_base_url = _prompt_text(
        input_func=input_func,
        prompt="API base URL",
        default=profile.default_base_url,
    )
    model_default = profile.default_model or ""
    model = _prompt_text(input_func=input_func, prompt="Model", default=model_default)
    api_key = _prompt_secret(secret_reader, "API key")

    config_path = default_user_config_path(home_dir)
    _write_user_config(
        config_path,
        provider=provider,
        protocol=profile.default_protocol.value,
        model=model,
        api_base_url=api_base_url,
        api_key=api_key,
    )
    output_func("")
    output_func(f"Saved configuration to {config_path}")
    output_func("Run `mycli doctor` if you want to verify the provider connection.")
    return SetupResult(
        config_path=config_path,
        provider=provider,
        model=model,
        api_base_url=api_base_url,
    )


def _prompt_provider(
    *,
    input_func: InputFunc,
    output_func: OutputFunc,
) -> ProviderId:
    output_func("Select provider:")
    for index, provider in enumerate(_PROVIDER_CHOICES, start=1):
        profile = profile_for_provider(provider)
        default_model = f" · default model {profile.default_model}" if profile.default_model else ""
        output_func(f"  {index}. {provider.value}{default_model}")
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
    api_key: str,
) -> None:
    existing = _read_toml(path)
    payload = {
        **existing,
        "provider": provider.value,
        "protocol": protocol,
        "model": model,
        "api_base_url": api_base_url.rstrip("/"),
        "api_key": api_key,
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
    preferred_order = ("provider", "protocol", "model", "api_base_url", "api_key")
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
