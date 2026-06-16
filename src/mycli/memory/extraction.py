from __future__ import annotations

import re
from dataclasses import dataclass

from mycli.domain.memory import MemoryKind

_REMEMBER_PATTERNS = (
    re.compile(r"(?:please\s+)?remember(?:\s+that)?\s+(?P<content>.+)", re.IGNORECASE | re.DOTALL),
    re.compile(r"(?:记住|请记住|帮我记住)[:：]?\s*(?P<content>.+)", re.DOTALL),
)
_FORGET_PATTERNS = (
    re.compile(r"(?:forget|remove memory(?:\s+about)?)\s+(?P<query>.+)", re.IGNORECASE | re.DOTALL),
    re.compile(r"(?:忘记|删掉记忆|删除记忆)[:：]?\s*(?P<query>.+)", re.DOTALL),
)


@dataclass(slots=True, frozen=True)
class MemoryExtraction:
    action: str
    content: str
    kind: MemoryKind = MemoryKind.FEEDBACK
    name: str = ""
    description: str = ""


def extract_explicit_memory_request(user_message: str) -> MemoryExtraction | None:
    normalized = user_message.strip()
    if not normalized:
        return None
    forget = _match_forget(normalized)
    if forget:
        return MemoryExtraction(action="forget", content=forget)
    remembered = _match_remember(normalized)
    if not remembered:
        return None
    kind = _classify_kind(remembered)
    name = _name_for(remembered)
    return MemoryExtraction(
        action="remember",
        content=remembered,
        kind=kind,
        name=name,
        description=_description_for(remembered),
    )


def _match_remember(value: str) -> str:
    for pattern in _REMEMBER_PATTERNS:
        match = pattern.search(value)
        if match is not None:
            return _clean_content(match.group("content"))
    return ""


def _match_forget(value: str) -> str:
    for pattern in _FORGET_PATTERNS:
        match = pattern.search(value)
        if match is not None:
            return _clean_content(match.group("query"))
    return ""


def _classify_kind(content: str) -> MemoryKind:
    lowered = content.lower()
    if any(token in lowered for token in ("i prefer", "my preference", "我希望", "我喜欢", "偏好")):
        return MemoryKind.USER
    if any(token in lowered for token in ("don't", "do not", "stop", "不要", "别再", "以后你")):
        return MemoryKind.FEEDBACK
    if any(token in lowered for token in ("project", "repo", "deadline", "release", "项目", "仓库", "上线")):
        return MemoryKind.PROJECT
    if any(token in lowered for token in ("http://", "https://", "linear", "grafana", "dashboard")):
        return MemoryKind.REFERENCE
    return MemoryKind.FEEDBACK


def _name_for(content: str) -> str:
    words = re.findall(r"[\w\u4e00-\u9fff]+", content.lower())
    if not words:
        return "memory"
    return " ".join(words[:6])


def _description_for(content: str) -> str:
    cleaned = " ".join(content.split())
    if len(cleaned) <= 140:
        return cleaned
    return cleaned[:137].rstrip() + "..."


def _clean_content(value: str) -> str:
    cleaned = value.strip().strip(".。")
    return " ".join(cleaned.split())
