from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Protocol

from mycli.memory.memdir import FileMemory, format_memory_manifest
from mycli.memory.prompts import SELECT_MEMORIES_SYSTEM_PROMPT


class CompletionClient(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        model: str,
        max_tokens: int,
    ) -> str: ...


class FileMemorySelector(Protocol):
    def select(
        self,
        query: str,
        memories: tuple[FileMemory, ...],
        *,
        limit: int,
    ) -> tuple[str, ...]: ...


@dataclass(slots=True)
class ModelFileMemorySelector:
    client: CompletionClient
    model: str
    max_tokens: int = 512

    def select(
        self,
        query: str,
        memories: tuple[FileMemory, ...],
        *,
        limit: int,
    ) -> tuple[str, ...]:
        if not query.strip() or not memories:
            return ()
        manifest = format_memory_manifest(memories)
        if not manifest:
            return ()
        response = self.client.complete(
            messages=[
                {"role": "system", "content": SELECT_MEMORIES_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"User query:\n{query.strip()}\n\n"
                        f"Available memory files:\n{manifest}\n\n"
                        f"Select up to {limit} memory files. Return JSON only."
                    ),
                },
            ],
            model=self.model,
            max_tokens=self.max_tokens,
        )
        return _selected_filenames(
            response,
            available={memory.filename for memory in memories},
            limit=limit,
        )


def _selected_filenames(
    response: str,
    *,
    available: set[str],
    limit: int,
) -> tuple[str, ...]:
    if limit <= 0:
        return ()
    payload = _parse_json_object(response)
    values = payload.get("selected_memories")
    if not isinstance(values, list):
        return ()
    selected: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        filename = value.strip()
        if filename in available and filename not in selected:
            selected.append(filename)
        if len(selected) >= limit:
            break
    return tuple(selected)


def _parse_json_object(response: str) -> dict[str, object]:
    text = response.strip()
    if not text:
        return {}
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.DOTALL)
    if fenced:
        text = fenced.group(1)
    elif not text.startswith("{"):
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return {}
        text = text[start : end + 1]
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}
