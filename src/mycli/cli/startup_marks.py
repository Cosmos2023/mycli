from __future__ import annotations

import random

_MARKS: dict[str, str] = {
    "default": "  mycli\n ▐▛███▜▌\n▝▜█████▛▘\n  ▘▘ ▝▝",
    "rat": "<:3 )~~",
    "ox": " (__)\n (oo)\\_______",
    "tiger": "/\\_/\\\n> ^ <",
    "rabbit": "(\\__/)\n(='.'=)\n(\")_(\")",
    "dragon": "<~\\___/~\n  /  _  \\",
    "snake": "~~~\\__\n     \\_)",
    "horse": " //\\__\n(/    \\",
    "goat": " /\\_/\\\n( goat )",
    "monkey": "@(o.o)@",
    "rooster": "<(' )\n  /|\\",
    "dog": "/ \\__\n(    @\\___",
    "pig": "^(oo)^\n (__) ",
}


def startup_mark(name: str | None) -> str:
    key = (name or "default").strip().lower()
    if key == "random-zodiac":
        zodiac_names = tuple(name for name in _MARKS if name != "default")
        key = random.choice(zodiac_names)
    return _MARKS.get(key, _MARKS["default"])
