from __future__ import annotations

import hashlib
import time
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import requests


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
        import markdownify

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
        return entry["data"]

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
