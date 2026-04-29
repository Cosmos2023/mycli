# Runtime V2 Phase 1 Request Shape Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral request shape domain types and cache shape diagnostics without changing current runtime behavior.

**Architecture:** Phase 1 introduces immutable request-shape fragments, deterministic hashing, provider-message shape summaries, and a diagnostic builder that can compare adjacent request shapes. It does not wire the new types into `agent_runtime` yet; the output is a tested foundation for later migration of context, memory, tools, and provider formatters.

**Tech Stack:** Python 3.13, dataclasses, StrEnum, hashlib, pytest, ruff, mypy.

---

## Scope Check

The full Runtime v2 spec spans request shape, memory, tool policy, provider formatter boundaries, reasoning replay, and diagnostics. This plan intentionally implements only the first independent slice:

- Create request shape domain types.
- Create cache shape diagnostics.
- Export the new types.
- Add unit tests.
- Run focused and full verification.

Later plans should cover `ToolCatalog/ToolPolicy`, memory v2, provider formatter migration, and runtime wiring.

Phase 1 deliberately avoids changing live request assembly. It must land before plans that alter tool schema ordering, memory injection, provider formatter boundaries, or deterministic replay wiring.

## File Structure

- Create `src/mycli/domain/runtime/request_shape.py`
  - Owns `RequestFragment`, `RequestShape`, `ProviderMessageShape`, hash helpers, and request-shape enums.
  - Contains no provider SDK imports and no runtime side effects.

- Modify `src/mycli/domain/runtime/__init__.py`
  - Re-exports request shape types for existing runtime import style.

- Create `src/mycli/services/cache_shape_diagnostics.py`
  - Owns diagnostic dataclasses and `CacheShapeDiagnostics.build`.
  - Compares current and previous `RequestShape` values by system hash, tool hashes, fragment hashes, and provider message hashes.

- Create `tests/unit/domain/runtime/test_request_shape.py`
  - Tests deterministic hashing, immutability-friendly tuple normalization, fragment validation, and request shape summaries.

- Create `tests/unit/services/test_cache_shape_diagnostics.py`
  - Tests first changed fragment detection, first changed provider message index detection, usage extraction, and no-previous-shape behavior.

## Task 1: Add Request Shape Domain Types

**Files:**
- Create: `src/mycli/domain/runtime/request_shape.py`
- Test: `tests/unit/domain/runtime/test_request_shape.py`

- [ ] **Step 1: Write failing tests for request fragments and shape hashes**

Create `tests/unit/domain/runtime/test_request_shape.py` with:

```python
from __future__ import annotations

import pytest

from mycli.domain.runtime.request_shape import (
    FragmentStability,
    ProviderMessageShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
    stable_hash,
)


def test_stable_hash_is_deterministic() -> None:
    assert stable_hash("same text") == stable_hash("same text")
    assert stable_hash("same text") != stable_hash("different text")
    assert len(stable_hash("same text")) == 64


def test_request_fragment_rejects_blank_id() -> None:
    with pytest.raises(ValueError, match="fragment id cannot be blank"):
        RequestFragment(
            id=" ",
            kind=RequestFragmentKind.INTENT,
            content="hello",
            stability=FragmentStability.VOLATILE,
        )


def test_request_fragment_derives_hash_and_length() -> None:
    fragment = RequestFragment(
        id="intent:current",
        kind=RequestFragmentKind.INTENT,
        content="用户问题",
        stability=FragmentStability.VOLATILE,
        provider_visibility=("deepseek", "qwen"),
    )

    assert fragment.content_hash == stable_hash("用户问题")
    assert fragment.char_length == len("用户问题")
    assert fragment.provider_visibility == ("deepseek", "qwen")


def test_request_shape_summarizes_fragments_and_messages() -> None:
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable system",
        tool_schema_hash="tool-schema",
        tool_order_hash="tool-order",
        fragments=(
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content="fix cache",
                stability=FragmentStability.VOLATILE,
            ),
        ),
        provider_messages=(
            ProviderMessageShape(role="system", content="stable system"),
            ProviderMessageShape(role="user", content="fix cache"),
        ),
    )

    summary = shape.summary()

    assert summary["provider"] == "deepseek"
    assert summary["protocol"] == "chat_completions"
    assert summary["model"] == "deepseek-v4-flash"
    assert summary["system_hash"] == stable_hash("stable system")
    assert summary["tool_schema_hash"] == "tool-schema"
    assert summary["tool_order_hash"] == "tool-order"
    assert summary["fragment_hashes"] == {"intent:current": stable_hash("fix cache")}
    assert summary["provider_message_hashes"] == (
        stable_hash("system\nstable system"),
        stable_hash("user\nfix cache"),
    )
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/domain/runtime/test_request_shape.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mycli.domain.runtime.request_shape'`.

- [ ] **Step 3: Implement `request_shape.py`**

Create `src/mycli/domain/runtime/request_shape.py` with:

```python
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


def stable_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class FragmentStability(StrEnum):
    STABLE = "stable"
    REPLAY = "replay"
    VOLATILE = "volatile"


class RequestFragmentKind(StrEnum):
    STABLE = "stable"
    REPLAY = "replay"
    INTENT = "intent"
    VOLATILE = "volatile"
    RETRIEVED_MEMORY = "retrieved_memory"
    EVIDENCE_INDEX = "evidence_index"
    TOOL_POLICY = "tool_policy"


@dataclass(slots=True, frozen=True)
class RequestFragment:
    id: str
    kind: RequestFragmentKind
    content: str
    stability: FragmentStability
    dedupe_key: str | None = None
    budget_weight: int = 1
    provider_visibility: tuple[str, ...] = ("all",)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id.strip():
            raise ValueError("fragment id cannot be blank")
        if self.budget_weight < 0:
            raise ValueError("budget_weight cannot be negative")
        if not self.provider_visibility:
            raise ValueError("provider_visibility cannot be empty")

    @property
    def content_hash(self) -> str:
        return stable_hash(self.content)

    @property
    def char_length(self) -> int:
        return len(self.content)


@dataclass(slots=True, frozen=True)
class ProviderMessageShape:
    role: str
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.role.strip():
            raise ValueError("provider message role cannot be blank")

    @property
    def content_hash(self) -> str:
        return stable_hash(f"{self.role}\n{self.content}")

    @property
    def char_length(self) -> int:
        return len(self.content)


@dataclass(slots=True, frozen=True)
class RequestShape:
    provider: str
    protocol: str
    model: str
    stable_system: str
    tool_schema_hash: str | None = None
    tool_order_hash: str | None = None
    fragments: tuple[RequestFragment, ...] = ()
    provider_messages: tuple[ProviderMessageShape, ...] = ()

    def __post_init__(self) -> None:
        if not self.provider.strip():
            raise ValueError("provider cannot be blank")
        if not self.protocol.strip():
            raise ValueError("protocol cannot be blank")
        if not self.model.strip():
            raise ValueError("model cannot be blank")

    @property
    def system_hash(self) -> str:
        return stable_hash(self.stable_system)

    @property
    def replay_hash(self) -> str:
        replay_hashes = [
            fragment.content_hash
            for fragment in self.fragments
            if fragment.stability is FragmentStability.REPLAY
        ]
        return stable_hash("\n".join(replay_hashes))

    @property
    def volatile_hash(self) -> str:
        volatile_hashes = [
            fragment.content_hash
            for fragment in self.fragments
            if fragment.stability is FragmentStability.VOLATILE
        ]
        return stable_hash("\n".join(volatile_hashes))

    def fragment_hashes(self) -> dict[str, str]:
        return {fragment.id: fragment.content_hash for fragment in self.fragments}

    def provider_message_hashes(self) -> tuple[str, ...]:
        return tuple(message.content_hash for message in self.provider_messages)

    def summary(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "protocol": self.protocol,
            "model": self.model,
            "system_hash": self.system_hash,
            "tool_schema_hash": self.tool_schema_hash,
            "tool_order_hash": self.tool_order_hash,
            "replay_hash": self.replay_hash,
            "volatile_hash": self.volatile_hash,
            "fragment_hashes": self.fragment_hashes(),
            "provider_message_hashes": self.provider_message_hashes(),
            "fragment_lengths": {
                fragment.id: fragment.char_length for fragment in self.fragments
            },
            "provider_message_lengths": tuple(
                message.char_length for message in self.provider_messages
            ),
        }
```

- [ ] **Step 4: Run request shape tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/domain/runtime/test_request_shape.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit request shape domain types**

Run:

```bash
git add src/mycli/domain/runtime/request_shape.py tests/unit/domain/runtime/test_request_shape.py
git commit -m "Add provider-neutral request shape domain types" \
  -m "Runtime v2 needs a stable shape model before behavior changes can move out of agent_runtime. This introduces immutable fragments, provider message summaries, and deterministic hashes without wiring them into the live runtime." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/domain/runtime/test_request_shape.py -q"
```

## Task 2: Export Request Shape Types

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Test: `tests/unit/domain/test_runtime.py`

- [ ] **Step 1: Add failing export test**

Append this test to `tests/unit/domain/test_runtime.py`:

```python
def test_runtime_exports_request_shape_types() -> None:
    from mycli.domain.runtime import (
        FragmentStability,
        ProviderMessageShape,
        RequestFragment,
        RequestFragmentKind,
        RequestShape,
    )

    fragment = RequestFragment(
        id="intent:current",
        kind=RequestFragmentKind.INTENT,
        content="hello",
        stability=FragmentStability.VOLATILE,
    )
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="system",
        fragments=(fragment,),
        provider_messages=(ProviderMessageShape(role="user", content="hello"),),
    )

    assert shape.fragment_hashes()["intent:current"] == fragment.content_hash
```

- [ ] **Step 2: Run export test and verify it fails**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_runtime_exports_request_shape_types -q
```

Expected: FAIL with an import error for one of the new request shape types.

- [ ] **Step 3: Re-export types from runtime package**

Modify `src/mycli/domain/runtime/__init__.py` by adding this import block near the other runtime domain imports:

```python
from mycli.domain.runtime.request_shape import (
    FragmentStability as FragmentStability,
    ProviderMessageShape as ProviderMessageShape,
    RequestFragment as RequestFragment,
    RequestFragmentKind as RequestFragmentKind,
    RequestShape as RequestShape,
    stable_hash as stable_hash,
)
```

Add these names to `__all__`:

```python
    "FragmentStability",
    "ProviderMessageShape",
    "RequestFragment",
    "RequestFragmentKind",
    "RequestShape",
    "stable_hash",
```

- [ ] **Step 4: Run export test and request shape tests**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py::test_runtime_exports_request_shape_types tests/unit/domain/runtime/test_request_shape.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit exports**

Run:

```bash
git add src/mycli/domain/runtime/__init__.py tests/unit/domain/test_runtime.py
git commit -m "Export runtime request shape types" \
  -m "The runtime package already re-exports domain runtime contracts. Exporting request shape types keeps the public import style consistent for later Runtime v2 migration tasks." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/domain/test_runtime.py::test_runtime_exports_request_shape_types tests/unit/domain/runtime/test_request_shape.py -q"
```

## Task 3: Add Cache Shape Diagnostics Service

**Files:**
- Create: `src/mycli/services/cache_shape_diagnostics.py`
- Test: `tests/unit/services/test_cache_shape_diagnostics.py`

- [ ] **Step 1: Write failing diagnostics tests**

Create `tests/unit/services/test_cache_shape_diagnostics.py` with:

```python
from __future__ import annotations

from mycli.domain.runtime import (
    FragmentStability,
    ProviderMessageShape,
    RequestFragment,
    RequestFragmentKind,
    RequestShape,
)
from mycli.services.cache_shape_diagnostics import CacheShapeDiagnostics


def _shape(*, fragment_content: str, second_message: str = "same") -> RequestShape:
    return RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable system",
        tool_schema_hash="tool-schema",
        tool_order_hash="tool-order",
        fragments=(
            RequestFragment(
                id="intent:current",
                kind=RequestFragmentKind.INTENT,
                content=fragment_content,
                stability=FragmentStability.VOLATILE,
            ),
        ),
        provider_messages=(
            ProviderMessageShape(role="system", content="stable system"),
            ProviderMessageShape(role="user", content=second_message),
        ),
    )


def test_diagnostic_without_previous_shape_has_no_first_diff() -> None:
    diagnostic = CacheShapeDiagnostics().build(
        current=_shape(fragment_content="first"),
        usage={"prompt_tokens": 100, "prompt_cache_hit_tokens": 80, "prompt_cache_miss_tokens": 20},
    )

    payload = diagnostic.to_dict()

    assert payload["first_changed_fragment_id"] is None
    assert payload["first_changed_provider_message_index"] is None
    assert payload["prompt_tokens"] == 100
    assert payload["cache_hit_tokens"] == 80
    assert payload["cache_miss_tokens"] == 20
    assert payload["cache_hit_ratio"] == 0.8


def test_diagnostic_finds_first_changed_fragment() -> None:
    previous = _shape(fragment_content="first")
    current = _shape(fragment_content="second")

    diagnostic = CacheShapeDiagnostics().build(current=current, previous=previous)

    assert diagnostic.first_changed_fragment_id == "intent:current"
    assert diagnostic.first_changed_provider_message_index is None


def test_diagnostic_finds_first_changed_provider_message_index() -> None:
    previous = _shape(fragment_content="same", second_message="before")
    current = _shape(fragment_content="same", second_message="after")

    diagnostic = CacheShapeDiagnostics().build(current=current, previous=previous)

    assert diagnostic.first_changed_fragment_id is None
    assert diagnostic.first_changed_provider_message_index == 1
```

- [ ] **Step 2: Run diagnostics tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/services/test_cache_shape_diagnostics.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'mycli.services.cache_shape_diagnostics'`.

- [ ] **Step 3: Implement diagnostics service**

Create `src/mycli/services/cache_shape_diagnostics.py` with:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from mycli.domain.runtime import RequestShape


@dataclass(slots=True, frozen=True)
class RequestShapeDiagnostic:
    provider: str
    protocol: str
    model: str
    system_hash: str
    tool_schema_hash: str | None
    tool_order_hash: str | None
    replay_hash: str
    volatile_hash: str
    fragment_hashes: dict[str, str]
    provider_message_hashes: tuple[str, ...]
    fragment_lengths: dict[str, int]
    provider_message_lengths: tuple[int, ...]
    first_changed_fragment_id: str | None = None
    first_changed_provider_message_index: int | None = None
    prompt_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def cache_hit_ratio(self) -> float:
        total = self.cache_hit_tokens + self.cache_miss_tokens
        if total == 0:
            return 0.0
        return self.cache_hit_tokens / total

    def to_dict(self) -> dict[str, object]:
        return {
            "provider": self.provider,
            "protocol": self.protocol,
            "model": self.model,
            "system_hash": self.system_hash,
            "tool_schema_hash": self.tool_schema_hash,
            "tool_order_hash": self.tool_order_hash,
            "replay_hash": self.replay_hash,
            "volatile_hash": self.volatile_hash,
            "fragment_hashes": self.fragment_hashes,
            "provider_message_hashes": self.provider_message_hashes,
            "fragment_lengths": self.fragment_lengths,
            "provider_message_lengths": self.provider_message_lengths,
            "first_changed_fragment_id": self.first_changed_fragment_id,
            "first_changed_provider_message_index": self.first_changed_provider_message_index,
            "prompt_tokens": self.prompt_tokens,
            "cache_hit_tokens": self.cache_hit_tokens,
            "cache_miss_tokens": self.cache_miss_tokens,
            "cache_hit_ratio": self.cache_hit_ratio,
            "metadata": self.metadata,
        }


class CacheShapeDiagnostics:
    def build(
        self,
        *,
        current: RequestShape,
        previous: RequestShape | None = None,
        usage: dict[str, object] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RequestShapeDiagnostic:
        current_summary = current.summary()
        previous_summary = None if previous is None else previous.summary()
        usage_payload = {} if usage is None else usage
        return RequestShapeDiagnostic(
            provider=current.provider,
            protocol=current.protocol,
            model=current.model,
            system_hash=current.system_hash,
            tool_schema_hash=current.tool_schema_hash,
            tool_order_hash=current.tool_order_hash,
            replay_hash=current.replay_hash,
            volatile_hash=current.volatile_hash,
            fragment_hashes=dict(current_summary["fragment_hashes"]),
            provider_message_hashes=tuple(current_summary["provider_message_hashes"]),
            fragment_lengths=dict(current_summary["fragment_lengths"]),
            provider_message_lengths=tuple(current_summary["provider_message_lengths"]),
            first_changed_fragment_id=self._first_changed_fragment_id(
                current_summary=current_summary,
                previous_summary=previous_summary,
            ),
            first_changed_provider_message_index=self._first_changed_provider_message_index(
                current_summary=current_summary,
                previous_summary=previous_summary,
            ),
            prompt_tokens=self._int_usage(usage_payload, "prompt_tokens"),
            cache_hit_tokens=self._int_usage(usage_payload, "prompt_cache_hit_tokens"),
            cache_miss_tokens=self._int_usage(usage_payload, "prompt_cache_miss_tokens"),
            metadata={} if metadata is None else dict(metadata),
        )

    def _first_changed_fragment_id(
        self,
        *,
        current_summary: dict[str, object],
        previous_summary: dict[str, object] | None,
    ) -> str | None:
        if previous_summary is None:
            return None
        current_hashes = current_summary["fragment_hashes"]
        previous_hashes = previous_summary["fragment_hashes"]
        if not isinstance(current_hashes, dict) or not isinstance(previous_hashes, dict):
            return None
        ordered_ids = list(dict.fromkeys([*previous_hashes.keys(), *current_hashes.keys()]))
        for fragment_id in ordered_ids:
            if previous_hashes.get(fragment_id) != current_hashes.get(fragment_id):
                return str(fragment_id)
        return None

    def _first_changed_provider_message_index(
        self,
        *,
        current_summary: dict[str, object],
        previous_summary: dict[str, object] | None,
    ) -> int | None:
        if previous_summary is None:
            return None
        current_hashes = current_summary["provider_message_hashes"]
        previous_hashes = previous_summary["provider_message_hashes"]
        if not isinstance(current_hashes, tuple) or not isinstance(previous_hashes, tuple):
            return None
        max_length = max(len(previous_hashes), len(current_hashes))
        for index in range(max_length):
            previous_hash = previous_hashes[index] if index < len(previous_hashes) else None
            current_hash = current_hashes[index] if index < len(current_hashes) else None
            if previous_hash != current_hash:
                return index
        return None

    def _int_usage(self, usage: dict[str, object], key: str) -> int:
        value = usage.get(key, 0)
        if isinstance(value, bool):
            return 0
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        return 0
```

- [ ] **Step 4: Run diagnostics tests and verify they pass**

Run:

```bash
uv run pytest tests/unit/services/test_cache_shape_diagnostics.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit diagnostics service**

Run:

```bash
git add src/mycli/services/cache_shape_diagnostics.py tests/unit/services/test_cache_shape_diagnostics.py
git commit -m "Add cache shape diagnostics service" \
  -m "Runtime v2 needs evidence for request drift before changing prompt assembly. This service compares request shapes and reports first changed fragments, provider message indexes, and cache usage ratios." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run pytest tests/unit/services/test_cache_shape_diagnostics.py -q"
```

## Task 4: Add Documentation Linkage to the Design

**Files:**
- Modify: `docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md`
- Modify: `docs/superpowers/plans/2026-04-29-runtime-v2-phase1-request-shape-diagnostics.md`

- [ ] **Step 1: Add implementation status note to the design**

Add this paragraph after the design summary in `docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md`:

```markdown
Implementation starts with Phase 1, which adds provider-neutral `RequestShape` domain types and cache shape diagnostics without changing runtime behavior. Later phases migrate tools, memory, provider formatting, and runtime assembly onto those contracts.
```

- [ ] **Step 2: Add phase dependency note to this plan**

Add this paragraph under this plan's Scope Check section:

```markdown
Phase 1 deliberately avoids changing live request assembly. It must land before plans that alter tool schema ordering, memory injection, provider formatter boundaries, or deterministic replay wiring.
```

- [ ] **Step 3: Review docs diff**

Run:

```bash
git diff -- docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md docs/superpowers/plans/2026-04-29-runtime-v2-phase1-request-shape-diagnostics.md
```

Expected: diff shows only the two documentation notes above.

- [ ] **Step 4: Commit documentation linkage**

Run:

```bash
git add docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md docs/superpowers/plans/2026-04-29-runtime-v2-phase1-request-shape-diagnostics.md
git commit -m "Document runtime v2 phase one boundary" \
  -m "The Runtime v2 architecture is broad, so this records that request shape types and diagnostics are the first behavior-preserving implementation slice." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: git diff review of documentation-only changes"
```

## Task 5: Run Phase 1 Verification

**Files:**
- Verify: `src/mycli/domain/runtime/request_shape.py`
- Verify: `src/mycli/services/cache_shape_diagnostics.py`
- Verify: `tests/unit/domain/runtime/test_request_shape.py`
- Verify: `tests/unit/services/test_cache_shape_diagnostics.py`

- [ ] **Step 1: Run focused tests**

Run:

```bash
uv run pytest tests/unit/domain/runtime/test_request_shape.py tests/unit/services/test_cache_shape_diagnostics.py -q
```

Expected: PASS.

- [ ] **Step 2: Run runtime domain and service tests touched by exports**

Run:

```bash
uv run pytest tests/unit/domain/test_runtime.py tests/unit/domain/runtime/test_request_shape.py tests/unit/services/test_cache_shape_diagnostics.py -q
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
uv run ruff check src/mycli/domain/runtime/request_shape.py src/mycli/services/cache_shape_diagnostics.py tests/unit/domain/runtime/test_request_shape.py tests/unit/services/test_cache_shape_diagnostics.py tests/unit/domain/test_runtime.py
```

Expected: PASS with `All checks passed!`.

- [ ] **Step 4: Run typecheck**

Run:

```bash
uv run mypy
```

Expected: PASS with no mypy errors.

- [ ] **Step 5: Run full test suite**

Run:

```bash
uv run pytest
```

Expected: PASS.

- [ ] **Step 6: Commit verification note if any test-only adjustment was needed**

If verification required changing code or tests, commit those exact changes:

```bash
git add src/mycli/domain/runtime/request_shape.py src/mycli/services/cache_shape_diagnostics.py tests/unit/domain/runtime/test_request_shape.py tests/unit/services/test_cache_shape_diagnostics.py tests/unit/domain/test_runtime.py
git commit -m "Stabilize runtime v2 phase one verification" \
  -m "Focused tests, lint, typecheck, and the full suite now pass for request shape and cache diagnostics." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: uv run ruff check targeted files; uv run mypy; uv run pytest"
```

If verification required no changes, do not create an empty commit.

## Self-Review

Spec coverage:

- Request shape domain types are covered by Tasks 1 and 2.
- Cache diagnostics are covered by Task 3.
- Phase boundary documentation is covered by Task 4.
- Verification is covered by Task 5.
- Tool policy, memory v2, provider formatter migration, deterministic replay wiring, and live runtime assembly are intentionally deferred to later plans because they are independent subsystems.

Placeholder scan:

- This plan contains no placeholder markers or unspecified implementation steps.
- Each code-changing step includes exact file paths, code, commands, and expected results.

Type consistency:

- `RequestShape`, `RequestFragment`, `ProviderMessageShape`, `FragmentStability`, `RequestFragmentKind`, and `stable_hash` are defined in Task 1 and exported in Task 2.
- `CacheShapeDiagnostics` and `RequestShapeDiagnostic` are defined in Task 3 and only depend on Task 1 and Task 2 contracts.
