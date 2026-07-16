from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Final


_EMAIL_PATTERN: Final = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)
_API_KEY_ASSIGNMENT_PATTERN: Final = re.compile(
    r"(?i)\b("
    r"(?:[a-z0-9_.-]*api[_-]?key[a-z0-9_.-]*)"
    r")(\s*[:=]\s*)([\"']?)([A-Za-z0-9_./+=:-]{12,})(\3)"
)
_OPENAI_KEY_PATTERN: Final = re.compile(
    r"\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b"
)
_TOKEN_ASSIGNMENT_PATTERN: Final = re.compile(
    r"(?i)\b("
    r"(?:[a-z0-9_.-]*(?:token|secret)[a-z0-9_.-]*)"
    r")(\s*[:=]\s*)([\"']?)([A-Za-z0-9_./+=:-]{12,})(\3)"
)
_BEARER_TOKEN_PATTERN: Final = re.compile(
    r"(?i)\b(Bearer\s+)([A-Za-z0-9_./+=:-]{12,})\b"
)
_GITHUB_TOKEN_PATTERN: Final = re.compile(
    r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b"
)


@dataclass(frozen=True, slots=True)
class PrivacyFilter:
    """Redact secrets and personal identifiers from low-trust text."""

    email_placeholder: str = "[REDACTED_EMAIL]"
    api_key_placeholder: str = "[REDACTED_API_KEY]"
    token_placeholder: str = "[REDACTED_TOKEN]"

    def redact(self, content: str) -> str:
        redacted = _API_KEY_ASSIGNMENT_PATTERN.sub(
            rf"\1\2\3{self.api_key_placeholder}\5",
            content,
        )
        redacted = _OPENAI_KEY_PATTERN.sub(self.api_key_placeholder, redacted)
        redacted = _TOKEN_ASSIGNMENT_PATTERN.sub(
            rf"\1\2\3{self.token_placeholder}\5",
            redacted,
        )
        redacted = _BEARER_TOKEN_PATTERN.sub(
            rf"\1{self.token_placeholder}",
            redacted,
        )
        redacted = _GITHUB_TOKEN_PATTERN.sub(self.token_placeholder, redacted)
        return _EMAIL_PATTERN.sub(self.email_placeholder, redacted)


@dataclass(frozen=True, slots=True)
class InjectionGuard:
    """Prepare low-trust tool output for prompt injection resistant inclusion."""

    privacy_filter: PrivacyFilter = field(default_factory=PrivacyFilter)

    def guard_tool_output(self, content: str) -> str:
        return self.privacy_filter.redact(content)
