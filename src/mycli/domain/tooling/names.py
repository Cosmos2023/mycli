from __future__ import annotations

import hashlib
import re

PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH = 64
_UNSAFE_TOOL_NAME_CHARS = re.compile(r"[^A-Za-z0-9]+")


def provider_safe_tool_name(*parts: str) -> str:
    """Build a provider-safe tool name from route parts.

    OpenAI-compatible tool schemas reject dotted contributed route names such as
    ``skill.code-review``. Keep provider-visible names alphanumeric plus
    underscores while callers preserve original source ids in metadata.
    """
    raw_name = "_".join(part.strip() for part in parts if part.strip())
    safe_name = _UNSAFE_TOOL_NAME_CHARS.sub("_", raw_name).strip("_")
    safe_name = safe_name or "tool"
    if len(safe_name) <= PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH:
        return safe_name
    suffix = hashlib.sha1(safe_name.encode("utf-8")).hexdigest()[:8]
    prefix_length = PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH - len(suffix) - 1
    return f"{safe_name[:prefix_length].rstrip('_')}_{suffix}"
