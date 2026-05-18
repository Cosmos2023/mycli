from __future__ import annotations

import os
from typing import Any, cast

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


def web_search(
    query: str,
    provider: str = "deepseek",
    allowed_domains: list[str] | None = None,
    blocked_domains: list[str] | None = None,
) -> dict[str, Any]:
    if provider == "deepseek":
        return {
            "_tool_definition": {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 3,
            },
            "query": query,
            "allowed_domains": allowed_domains or [],
            "blocked_domains": blocked_domains or [],
        }

    raw_results = _call_serpapi(query)
    if "error" in raw_results:
        return raw_results
    return _normalize_serpapi_results(raw_results)


def _serpapi_search(query: str) -> dict[str, Any]:
    raw_results = _call_serpapi(query)
    if "error" in raw_results:
        return raw_results
    return _normalize_serpapi_results(raw_results)


def _call_serpapi(query: str) -> dict[str, Any]:
    api_key = os.environ.get("SERPAPI_API_KEY", "")
    if not api_key:
        return {"error": "[WebSearch requires SERPAPI_API_KEY for non-DeepSeek providers]"}

    import requests  # type: ignore[import-untyped]

    response = requests.get(
        "https://serpapi.com/search",
        params={"q": query, "api_key": api_key, "engine": "google"},
        timeout=10,
    )
    return cast(dict[str, Any], response.json())


def _normalize_serpapi_results(data: dict[str, Any]) -> dict[str, Any]:
    organic_results = data.get("organic_results", [])[:10]
    results = [
        {"title": result["title"], "url": result["link"]}
        for result in organic_results
        if "title" in result and "link" in result
    ]
    return {"results": results, "total": len(results)}


class WebSearchTool:
    name = "WebSearch"
    spec = ToolSpec(
        name="WebSearch",
        description="Search the web. DeepSeek returns a server-side web_search tool definition; other providers use SerpAPI fallback.",
        parameters=(
            ToolParameter(name="query", type="string", required=True),
            ToolParameter(name="provider", type="string", required=False),
        ),
        risk_level="low",
    )

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        query = str(arguments.get("query") or "")
        if not query:
            return ToolResult(
                success=False,
                summary="Failed to search web",
                error="WebSearch requires query.",
            )
        payload = web_search(query, provider=str(arguments.get("provider", "deepseek")))
        success = "error" not in payload
        return ToolResult(
            success=success,
            summary=f"WebSearch for {query}",
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload=payload,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
