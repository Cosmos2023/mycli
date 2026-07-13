from __future__ import annotations

from hashlib import sha256

from mycli.prompts.loader import load_prompt_template

SYSTEM_PROMPT_VERSION = "2026-07-codex-style-base-v2"


def build_system_prompt() -> str:
    return load_prompt_template("system.md")


def system_prompt_hash(system_prompt: str | None = None) -> str:
    prompt = build_system_prompt() if system_prompt is None else system_prompt
    return sha256(prompt.encode("utf-8")).hexdigest()
