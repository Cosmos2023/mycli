from __future__ import annotations


def overlay_text(*, title: str, lines: tuple[str, ...]) -> str:
    body = "\n".join(lines) if lines else "No data."
    return f"{title}\n{'-' * len(title)}\n{body}"


def release_notes_text() -> str:
    return overlay_text(
        title="What's new",
        lines=(
            "TUI shell with rendered transcript",
            "Slash and @path suggestions",
            "Compact execution path rendering",
        ),
    )
