from __future__ import annotations

from mycli import __version__


def model_request_user_agent() -> str:
    return f"mycli/{__version__}"


def model_request_headers() -> dict[str, str]:
    return {"User-Agent": model_request_user_agent()}
