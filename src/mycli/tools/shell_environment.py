from __future__ import annotations

from fnmatch import fnmatchcase
import os
from typing import Mapping

from mycli.domain.runtime.execution_policy import (
    DEFAULT_SHELL_ENV_EXCLUDES,
    SAFE_SHELL_ENV_KEYS,
    ShellEnvironmentPolicy,
)
from mycli.tools.ripgrep_runtime import prepend_ripgrep_to_path

MYCLI_CI_ENV_VAR = "MYCLI_CI"
MYCLI_THREAD_ID_ENV_VAR = "MYCLI_THREAD_ID"
MYCLI_RIPGREP_PATH_DIR_ENV_VAR = "MYCLI_RIPGREP_PATH_DIR"


def create_shell_environment(
    policy: ShellEnvironmentPolicy,
    *,
    source_env: Mapping[str, str] | None = None,
) -> dict[str, str]:
    source = os.environ if source_env is None else source_env
    env = _initial_environment(policy, source)
    if not policy.ignore_default_excludes:
        env = _exclude_patterns(env, DEFAULT_SHELL_ENV_EXCLUDES)
    if policy.exclude:
        env = _exclude_patterns(env, policy.exclude)
    for key, value in (policy.set or {}).items():
        env[str(key)] = str(value)
    if policy.include_only:
        env = {
            key: value
            for key, value in env.items()
            if _matches_any(key, policy.include_only)
        }
    if policy.thread_id:
        env[MYCLI_THREAD_ID_ENV_VAR] = policy.thread_id
    env[MYCLI_CI_ENV_VAR] = "1"

    path_key = next((key for key in env if key.casefold() == "path"), "PATH")
    env[path_key], ripgrep_path_dir = prepend_ripgrep_to_path(env.get(path_key))
    if ripgrep_path_dir is not None:
        env[MYCLI_RIPGREP_PATH_DIR_ENV_VAR] = ripgrep_path_dir
    return env


def _initial_environment(
    policy: ShellEnvironmentPolicy,
    source: Mapping[str, str],
) -> dict[str, str]:
    if policy.inherit == "all":
        return {key: value for key, value in source.items() if isinstance(value, str)}
    if policy.inherit == "none":
        return {}
    return {
        key: value
        for key, value in source.items()
        if key in SAFE_SHELL_ENV_KEYS and isinstance(value, str)
    }


def _exclude_patterns(env: Mapping[str, str], patterns: tuple[str, ...]) -> dict[str, str]:
    return {
        key: value
        for key, value in env.items()
        if not _matches_any(key, patterns)
    }


def _matches_any(name: str, patterns: tuple[str, ...]) -> bool:
    normalized = name.lower()
    return any(fnmatchcase(normalized, pattern.lower()) for pattern in patterns)
