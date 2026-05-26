from __future__ import annotations

from pathlib import Path


def workspace_label(workspace_root: Path) -> str:
    name = workspace_root.name
    return name or str(workspace_root)


def format_bottom_status(*, config: object, snapshot: object) -> tuple[str, str]:
    workspace_root = getattr(config, "workspace_root")
    model = str(getattr(config, "model", "unknown"))
    max_prompt_tokens = _int_metric(getattr(config, "max_prompt_tokens", 0))
    context_window = getattr(snapshot, "context_window", {})
    context_window = context_window if isinstance(context_window, dict) else {}
    used_tokens = _int_metric(context_window.get("input_tokens"))
    if used_tokens <= 0:
        used_tokens = _int_metric(context_window.get("total_tokens"))
    max_tokens = _int_metric(context_window.get("max_tokens")) or max_prompt_tokens
    context = (
        f"context {used_tokens:,} / {max_tokens:,} tokens"
        if used_tokens > 0 and max_tokens > 0
        else "context unknown"
    )
    return (
        f"workspace · {workspace_label(workspace_root)}",
        f"{model} · {context}",
    )


def _int_metric(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0
