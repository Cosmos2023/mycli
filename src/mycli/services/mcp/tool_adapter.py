from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.output import (
    ToolImageContent,
    ToolJsonContent,
    ToolModelOutput,
    ToolOutputContent,
    ToolTextContent,
)
from mycli.domain.tooling.contributed_tools import (
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import ToolRouteKey
from mycli.services.mcp.client import McpClient, McpToolDescriptor
from mycli.services.mcp.diagnostics import classify_mcp_failure, redact_mcp_diagnostic_text
from mycli.tools.base import ToolEffectProfile, ToolResult, ToolSpec

MCP_TOOL_SUMMARY_LIMIT = 4000
MCP_TOOL_RAW_TEXT_LIMIT = 12000


@dataclass(slots=True)
class _McpSchemaTool:
    client: McpClient
    descriptor: McpToolDescriptor
    spec: ToolSpec

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        try:
            result = self.client.call_tool(self.descriptor.name, arguments)
        except Exception as exc:
            failure_category = classify_mcp_failure(exc)
            error = _truncate_text(redact_mcp_diagnostic_text(exc), MCP_TOOL_SUMMARY_LIMIT)
            return ToolResult(
                success=False,
                summary=f"MCP {self.descriptor.server_name}.{self.descriptor.name} failed: {failure_category}",
                raw_payload={
                    "server": self.descriptor.server_name,
                    "tool": self.descriptor.name,
                    "status": "failed",
                    "error_kind": failure_category,
                    "exception_type": type(exc).__name__,
                    "error": error,
                },
                error=error,
                model_output=ToolModelOutput.from_text(error, success=False),
            )
        result_text = result.text or "MCP tool returned no content."
        content_summary = _content_summary(result.content, text=result_text)
        status = "error" if result.is_error else "ok"
        summary = _truncate_text(
            f"MCP {self.descriptor.server_name}.{self.descriptor.name} {status}: {result_text}",
            MCP_TOOL_SUMMARY_LIMIT,
        )
        raw_content, raw_truncated = _bounded_content(result.content)
        summary_truncated = summary != f"MCP {self.descriptor.server_name}.{self.descriptor.name} {status}: {result_text}"
        content_summary["summary_chars"] = len(summary)
        content_summary["summary_truncated"] = summary_truncated
        content_summary["raw_truncated"] = raw_truncated
        return ToolResult(
            success=not result.is_error,
            summary=summary,
            raw_payload={
                "server": self.descriptor.server_name,
                "tool": self.descriptor.name,
                "status": status,
                "content": raw_content,
                "content_summary": content_summary,
                "is_error": result.is_error,
                "error_kind": "mcp_tool_error" if result.is_error else None,
                "truncated": raw_truncated or summary_truncated,
            },
            error=summary if result.is_error else None,
            model_output=_mcp_model_output(result),
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="unknown", network=True, process=True)


class McpToolAdapter:
    def __init__(self, clients: dict[str, McpClient]) -> None:
        self._clients = dict(clients)
        self._descriptors_by_route: dict[str, McpToolDescriptor] = {}

    def list_tool_stubs(self) -> tuple[ToolContributionRegistration, ...]:
        registrations: list[ToolContributionRegistration] = []
        for server_name, client in sorted(self._clients.items()):
            if not client.config.enabled:
                continue
            for descriptor in client.list_tools():
                self._descriptors_by_route[descriptor.route_name] = descriptor
                registrations.append(self._registration(client=client, descriptor=descriptor, hydrate=False))
        return tuple(registrations)

    def load_tool_schema(self, route_name: str) -> ToolSpec:
        descriptor = self._descriptors_by_route.get(route_name)
        if descriptor is None:
            descriptor = self._find_descriptor(route_name)
        return self._spec_for(descriptor, hydrate=True)

    def registrations_with_full_schema(self) -> tuple[ToolContributionRegistration, ...]:
        return tuple(
            self._registration(client=self._clients[descriptor.server_name], descriptor=descriptor, hydrate=True)
            for descriptor in sorted(self._descriptors_by_route.values(), key=lambda item: item.route_name)
        )

    def _find_descriptor(self, route_name: str) -> McpToolDescriptor:
        for server_name, client in sorted(self._clients.items()):
            if not client.config.enabled:
                continue
            for descriptor in client.list_tools():
                self._descriptors_by_route[descriptor.route_name] = descriptor
                if descriptor.route_name == route_name:
                    return descriptor
        raise ValueError(f"Unknown MCP tool route: {route_name}")

    def _registration(
        self,
        *,
        client: McpClient,
        descriptor: McpToolDescriptor,
        hydrate: bool,
    ) -> ToolContributionRegistration:
        spec = self._spec_for(descriptor, hydrate=hydrate)
        tool = _McpSchemaTool(client=client, descriptor=descriptor, spec=spec)
        return ToolContributionRegistration(
            descriptor=ToolContributionDescriptor(
                tool_id=f"mcp:{descriptor.server_name}:{descriptor.name}",
                display_name=descriptor.route_name,
                description=descriptor.description,
                route_key=ToolRouteKey.local(descriptor.route_name),
                source=ToolContributionSource.PROVIDER,
                scope=ToolContributionScope.THREAD,
                lifecycle_state=ToolContributionLifecycleState.DECLARED,
                spec=spec,
                origin_metadata={
                    "server": descriptor.server_name,
                    "tool": descriptor.name,
                    "transport": client.config.transport,
                    "timeout_seconds": client.config.timeout_seconds,
                    "deferred_schema": not hydrate,
                    "failure_semantics": "mcp_local_tool",
                    "result_summary_policy": "bounded_model_summary",
                    "risk_level": "medium",
                    "approval_policy": "auto_allow_or_request",
                    "legacy_route_name": descriptor.legacy_route_name,
                },
            ),
            tool=tool,
        )

    def _spec_for(self, descriptor: McpToolDescriptor, *, hydrate: bool) -> ToolSpec:
        return ToolSpec(
            name=descriptor.route_name,
            description=descriptor.description or f"MCP tool {descriptor.route_name}",
            parameters=descriptor.tool_parameters() if hydrate else (),
            risk_level="medium",
        )


def _truncate_text(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    omitted = len(value) - limit + 24
    suffix = f"... [truncated {omitted} chars]"
    return f"{value[: max(0, limit - len(suffix))]}{suffix}"


def _bounded_content(content: tuple[dict[str, Any], ...]) -> tuple[list[dict[str, Any]], bool]:
    bounded: list[dict[str, Any]] = []
    truncated = False
    for item in content:
        bounded_item: dict[str, Any] = {}
        for key, value in item.items():
            if isinstance(value, str):
                bounded_value = _truncate_text(value, MCP_TOOL_RAW_TEXT_LIMIT)
                truncated = truncated or bounded_value != value
                bounded_item[key] = bounded_value
            else:
                bounded_item[key] = value
        bounded.append(bounded_item)
    return bounded, truncated


def _content_summary(content: tuple[dict[str, Any], ...], *, text: str) -> dict[str, object]:
    type_counts: dict[str, int] = {}
    for item in content:
        item_type = str(item.get("type", "unknown"))
        type_counts[item_type] = type_counts.get(item_type, 0) + 1
    return {
        "item_count": len(content),
        "types": sorted(type_counts),
        "type_counts": type_counts,
        "text_chars": len(text),
    }


def _mcp_model_output(result: object) -> ToolModelOutput:
    content = getattr(result, "content", ())
    model_content: list[ToolOutputContent] = []
    if isinstance(content, tuple):
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "")
            if item_type == "text" and isinstance(item.get("text"), str):
                model_content.append(ToolTextContent(str(item["text"])))
                continue
            if item_type == "image":
                image_url = _mcp_image_url(item)
                if image_url is not None:
                    model_content.append(ToolImageContent(image_url))
                    continue
            if item_type == "json":
                model_content.append(ToolJsonContent(item.get("json", item.get("data"))))
                continue
            model_content.append(ToolJsonContent(dict(item)))

    structured_content = getattr(result, "structured_content", None)
    if structured_content is not None:
        model_content.append(ToolJsonContent(structured_content))
    if not model_content:
        model_content.append(ToolTextContent("MCP tool returned no content."))
    is_error = bool(getattr(result, "is_error", False))
    return ToolModelOutput(
        content=tuple(model_content),
        success=not is_error,
        contains_external_context=True,
    )


def _mcp_image_url(item: dict[str, Any]) -> str | None:
    url = item.get("url")
    if isinstance(url, str) and url.strip():
        return url
    data = item.get("data")
    mime_type = item.get("mimeType", item.get("mime_type"))
    if not isinstance(data, str) or not data:
        return None
    if not isinstance(mime_type, str) or not mime_type.startswith("image/"):
        return None
    return f"data:{mime_type};base64,{data}"
