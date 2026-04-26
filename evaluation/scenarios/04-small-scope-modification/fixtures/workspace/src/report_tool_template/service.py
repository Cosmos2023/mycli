from __future__ import annotations


def build_output_path(config: dict[str, str], filename: str) -> str:
    output_dir = config.get("output-dir", "dist")
    return f"{output_dir}/{filename}"
