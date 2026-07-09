from __future__ import annotations

import hashlib
import time
from html.parser import HTMLParser
from typing import Any, cast
from urllib.parse import urlparse

import requests  # type: ignore[import-untyped]

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec


_fetch_cache: dict[str, dict[str, Any]] = {}
_CACHE_TTL = 900
_CONTENT_LIMIT_CHARS = 100_000
_L1_LIMIT_CHARS = 20_000


def web_fetch(url: str, prompt: str | None = None) -> dict[str, Any]:
    del prompt
    normalized_url = _normalize_url(url)
    cache_key = hashlib.md5(normalized_url.encode(), usedforsecurity=False).hexdigest()
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached

    try:
        response = requests.get(
            normalized_url,
            timeout=30,
            allow_redirects=True,
            headers={"User-Agent": "mycli/1.0"},
        )
    except requests.RequestException as exc:
        return {"error": f"[Failed to fetch {normalized_url}: {exc}]"}

    if response.status_code != 200:
        return {"error": f"[HTTP {response.status_code} from {normalized_url}]"}

    markdown = _html_to_markdown(response.text)
    if len(markdown) > _CONTENT_LIMIT_CHARS:
        markdown = markdown[:_CONTENT_LIMIT_CHARS] + "\n[Content truncated at 100KB]"

    if len(markdown) > _L1_LIMIT_CHARS:
        markdown = markdown[:_L1_LIMIT_CHARS] + "\n[... truncated to 20K chars]"

    result = {"content": markdown, "url": normalized_url}
    _fetch_cache[cache_key] = {"ts": time.time(), "data": result}
    return result


def _normalize_url(url: str) -> str:
    normalized = url.strip()
    if normalized.startswith("http://"):
        normalized = f"https://{normalized[7:]}"

    parsed = urlparse(normalized)
    if parsed.username or parsed.password:
        clean = parsed._replace(netloc=parsed.hostname or parsed.netloc)
        normalized = clean.geturl()
    return normalized


def _html_to_markdown(html: str) -> str:
    try:
        import markdownify  # type: ignore[import-not-found]

        return str(markdownify.markdownify(html))
    except ImportError:
        parser = _BasicMarkdownParser()
        parser.feed(html)
        return parser.markdown()


def _get_cached(key: str) -> dict[str, Any] | None:
    entry = _fetch_cache.get(key)
    if entry is None:
        return None

    if time.time() - float(entry["ts"]) < _CACHE_TTL:
        return cast(dict[str, Any], entry["data"])

    del _fetch_cache[key]
    return None


class _BasicMarkdownParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag in {"h1", "h2", "h3", "p", "br", "li"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if text:
            self._parts.append(text)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"h1", "h2", "h3", "p", "li"}:
            self._parts.append("\n")

    def markdown(self) -> str:
        lines = [line.strip() for line in "".join(self._parts).splitlines()]
        return "\n".join(line for line in lines if line)


class WebFetchTool:
    name = "WebFetch"
    spec = ToolSpec(
        name="WebFetch",
        description="Fetch a URL and return bounded markdown content with a short cache.",
        parameters=(
            ToolParameter(name="url", type="string", required=True),
            ToolParameter(name="prompt", type="string", required=False),
        ),
        risk_level="low",
        supports_parallel_tool_calls=True,
    )

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(network=True)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        url = str(arguments.get("url") or "")
        if not url:
            return ToolResult(
                success=False,
                summary="Failed to fetch web page",
                error="WebFetch requires url.",
            )
        prompt = arguments.get("prompt")
        payload = web_fetch(url, prompt=prompt if isinstance(prompt, str) else None)
        success = "error" not in payload
        return ToolResult(
            success=success,
            summary=f"Fetched {url}" if success else f"Failed to fetch {url}",
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
