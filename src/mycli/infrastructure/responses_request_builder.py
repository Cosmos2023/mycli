from __future__ import annotations

import json
from dataclasses import dataclass

from mycli.schemas.responses_protocol import (
    ResponsesCapabilityProfile,
    ResponsesContinuationState,
)


@dataclass(slots=True, frozen=True)
class ResponsesRequestBuildResult:
    payload_body: dict[str, object]
    normalized_input: tuple[dict[str, object], ...]
    request_signature: str
    used_previous_response_id: str | None = None
    continuation_decision: str = "missing_state"


class ResponsesRequestBuilder:
    def __init__(
        self,
        *,
        capability_profile: ResponsesCapabilityProfile,
    ) -> None:
        self._capability_profile = capability_profile

    def build(
        self,
        *,
        model: str,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        max_output_tokens: int,
        reasoning_effort: str | None,
        thinking_enabled: bool = True,
        stream: bool,
        continuation_state: ResponsesContinuationState | None = None,
        parallel_tool_calls: bool = False,
        prompt_cache_key: str | None = None,
    ) -> ResponsesRequestBuildResult:
        effective_reasoning_effort = reasoning_effort if thinking_enabled else None
        normalized_input = tuple(self._normalize_input_items(input_items))
        request_signature = self._build_signature(
            model=model,
            tools=tools,
            max_output_tokens=max_output_tokens,
            reasoning_effort=effective_reasoning_effort,
            stream=stream,
            parallel_tool_calls=parallel_tool_calls,
        )
        payload_body: dict[str, object] = {
            "model": model,
            "input": [dict(item) for item in normalized_input],
            "tools": tools,
            "max_output_tokens": max_output_tokens,
        }
        if effective_reasoning_effort and self._capability_profile.supports_reasoning:
            payload_body["reasoning"] = {"effort": effective_reasoning_effort}
        if stream:
            payload_body["stream"] = True
        if self._capability_profile.supports_parallel_tool_calls:
            payload_body["parallel_tool_calls"] = parallel_tool_calls
        if prompt_cache_key:
            payload_body["prompt_cache_key"] = prompt_cache_key

        used_previous_response_id = self._maybe_apply_continuation(
            payload_body=payload_body,
            normalized_input=normalized_input,
            request_signature=request_signature,
            continuation_state=continuation_state,
        )

        return ResponsesRequestBuildResult(
            payload_body=payload_body,
            normalized_input=normalized_input,
            request_signature=request_signature,
            used_previous_response_id=used_previous_response_id,
            continuation_decision=self._continuation_decision(
                normalized_input=normalized_input,
                request_signature=request_signature,
                continuation_state=continuation_state,
                used_previous_response_id=used_previous_response_id,
            ),
        )

    def _normalize_input_items(
        self,
        input_items: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        normalized_items: list[dict[str, object]] = []
        for item in input_items:
            if not isinstance(item, dict):
                continue
            normalized = dict(item)
            role = normalized.get("role")
            content = normalized.get("content")
            if (
                role == "assistant"
                and self._capability_profile.requires_assistant_output_text
                and isinstance(content, list)
            ):
                normalized["content"] = self._normalize_assistant_content_items(content)
            if (
                normalized.get("type") == "function_call_output"
                and self._capability_profile.disallows_empty_function_call_output
            ):
                output = normalized.get("output")
                if output is None or (isinstance(output, str) and not output.strip()):
                    normalized["output"] = "Tool returned no output."
            normalized_items.append(normalized)
        return normalized_items

    def _normalize_assistant_content_items(
        self,
        content_items: list[object],
    ) -> list[object]:
        normalized_items = [
            self._normalize_assistant_content_item(content_item)
            for content_item in content_items
        ]
        merged_items: list[object] = []
        for item in normalized_items:
            if not isinstance(item, dict):
                merged_items.append(item)
                continue
            item_type = item.get("type")
            item_text = item.get("text")
            if item_type != "output_text" or not isinstance(item_text, str):
                merged_items.append(item)
                continue
            if (
                merged_items
                and isinstance(merged_items[-1], dict)
                and merged_items[-1].get("type") == "output_text"
                and isinstance(merged_items[-1].get("text"), str)
            ):
                merged_items[-1] = {
                    **merged_items[-1],
                    "text": str(merged_items[-1]["text"]) + item_text,
                }
                continue
            merged_items.append(item)
        return merged_items

    def _normalize_assistant_content_item(
        self,
        content_item: object,
    ) -> object:
        if not isinstance(content_item, dict):
            return content_item
        normalized = dict(content_item)
        if normalized.get("type") == "input_text":
            normalized["type"] = "output_text"
        return normalized

    def _build_signature(
        self,
        *,
        model: str,
        tools: list[dict[str, object]],
        max_output_tokens: int,
        reasoning_effort: str | None,
        stream: bool,
        parallel_tool_calls: bool,
    ) -> str:
        del reasoning_effort
        payload: dict[str, object] = {
            "model": model,
            "tools": tools,
            "max_output_tokens": max_output_tokens,
            "stream": stream,
        }
        if self._capability_profile.supports_parallel_tool_calls:
            payload["parallel_tool_calls"] = parallel_tool_calls
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def _maybe_apply_continuation(
        self,
        *,
        payload_body: dict[str, object],
        normalized_input: tuple[dict[str, object], ...],
        request_signature: str,
        continuation_state: ResponsesContinuationState | None,
    ) -> str | None:
        if not self._capability_profile.supports_previous_response_id:
            return None
        if continuation_state is None or not continuation_state.eligible:
            return None
        if not continuation_state.response_id:
            return None
        delta_input: tuple[dict[str, object], ...] | None = None
        if continuation_state.request_signature == request_signature:
            delta_input = self._continuation_delta_input(
                normalized_input=normalized_input,
                continuation_state=continuation_state,
            )
        if delta_input is None:
            delta_input = self._tool_result_fallback_delta_input(
                normalized_input=normalized_input,
                continuation_state=continuation_state,
            )
        if delta_input is None:
            return None

        payload_body["previous_response_id"] = continuation_state.response_id
        payload_body["input"] = [dict(item) for item in delta_input]
        payload_body["store"] = True
        return continuation_state.response_id

    def _continuation_decision(
        self,
        *,
        normalized_input: tuple[dict[str, object], ...],
        request_signature: str,
        continuation_state: ResponsesContinuationState | None,
        used_previous_response_id: str | None,
    ) -> str:
        if used_previous_response_id is not None:
            return "used_previous_response_id"
        if not self._capability_profile.supports_previous_response_id:
            return "capability_disabled"
        if continuation_state is None:
            return "missing_state"
        if not continuation_state.eligible:
            return "ineligible_state"
        if not continuation_state.response_id:
            return "missing_response_id"
        if continuation_state.request_signature != request_signature:
            if self._tool_result_fallback_delta_input(
                normalized_input=normalized_input,
                continuation_state=continuation_state,
            ) is not None:
                return "used_previous_response_id"
            return "signature_mismatch"
        if (
            self._continuation_delta_input(
                normalized_input=normalized_input,
                continuation_state=continuation_state,
            )
            is not None
        ):
            return "used_previous_response_id"
        baseline = continuation_state.baseline_input()
        baseline_len = len(baseline)
        if baseline_len == 0:
            return "empty_baseline"
        if len(normalized_input) <= baseline_len:
            return "input_not_extended"
        if tuple(normalized_input[:baseline_len]) != baseline:
            if self._tool_result_fallback_delta_input(
                normalized_input=normalized_input,
                continuation_state=continuation_state,
            ) is not None:
                return "used_previous_response_id"
            return "input_prefix_mismatch"
        return "unknown"

    def _continuation_delta_input(
        self,
        *,
        normalized_input: tuple[dict[str, object], ...],
        continuation_state: ResponsesContinuationState,
    ) -> tuple[dict[str, object], ...] | None:
        strict_delta = self._strict_extension_delta(
            normalized_input=normalized_input,
            baseline=self._normalize_saved_items(continuation_state.baseline_input()),
        )
        if strict_delta is not None:
            return strict_delta
        return self._response_output_tail_delta(
            normalized_input=normalized_input,
            response_output=self._normalize_saved_items(continuation_state.response_output),
        )

    def _normalize_saved_items(
        self,
        items: tuple[dict[str, object], ...],
    ) -> tuple[dict[str, object], ...]:
        return tuple(self._normalize_input_items([dict(item) for item in items]))

    def _strict_extension_delta(
        self,
        *,
        normalized_input: tuple[dict[str, object], ...],
        baseline: tuple[dict[str, object], ...],
    ) -> tuple[dict[str, object], ...] | None:
        baseline_len = len(baseline)
        if baseline_len == 0:
            return None
        if len(normalized_input) <= baseline_len:
            return None
        if tuple(normalized_input[:baseline_len]) != baseline:
            return None
        return normalized_input[baseline_len:]

    def _response_output_tail_delta(
        self,
        *,
        normalized_input: tuple[dict[str, object], ...],
        response_output: tuple[dict[str, object], ...],
    ) -> tuple[dict[str, object], ...] | None:
        output_len = len(response_output)
        if output_len == 0:
            return None
        if len(normalized_input) <= output_len:
            return None
        last_match_start: int | None = None
        for start in range(len(normalized_input) - output_len):
            if tuple(normalized_input[start : start + output_len]) == response_output:
                last_match_start = start
        if last_match_start is None:
            return None
        delta_start = last_match_start + output_len
        if delta_start >= len(normalized_input):
            return None
        return normalized_input[delta_start:]

    def _tool_result_fallback_delta_input(
        self,
        *,
        normalized_input: tuple[dict[str, object], ...],
        continuation_state: ResponsesContinuationState,
    ) -> tuple[dict[str, object], ...] | None:
        del continuation_state
        for index, item in enumerate(normalized_input):
            if item.get("type") == "function_call_output":
                tail = normalized_input[index:]
                return tail if tail else None
        return None
