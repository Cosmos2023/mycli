from __future__ import annotations

from importlib.resources import files


def load_prompt_template(name: str) -> str:
    return (
        files("mycli.prompts.templates")
        .joinpath(name)
        .read_text(encoding="utf-8")
        .strip()
    )
