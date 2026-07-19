# Codex-Style Slash Command Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tagged slash-command text with a versioned structured result that renders as Codex-style semantic history cells, persists across resume, remains invisible to the model, and projects cleanly to plain-text clients.

**Architecture:** Python owns a typed `SlashCommandDisplay` contract and deterministic text projection. Gateway persists transcript-visible displays as `COMMAND_RESULT` history with stable IDs, while the Node TUI validates the contract and routes it to status, diagnostic, list, notice, error, or preformatted components. An isolated legacy adapter upgrades recognizable old tagged output only during transcript loading.

**Tech Stack:** Python 3.12 dataclasses and `StrEnum`, JSON-RPC Gateway, SQLite-backed session history, TypeScript, Node test runner, the existing custom terminal component framework, pytest, Ruff, mypy, and `tsc`.

---

## File Structure

### Python Command Domain

- Create `src/mycli/cli/slash_command_result.py`: display dataclasses, validation, bounded serialization, and ANSI-free text projection.
- Create `src/mycli/cli/slash_command_presenters.py`: command-family presenters and the bounded migration tokenizer for current service values.
- Modify `src/mycli/cli/slash_command_dispatch.py`: construct structured displays and derive compatibility lines from them.
- Modify `src/mycli/cli/slash_command_registry.py`: make backend static results transcript-presented while preserving TUI overlays.
- Modify `src/mycli/cli/repl.py`: project registry resolution errors through the same plain-text command result path.

### Persistence And Gateway

- Modify `src/mycli/domain/runtime/session_history.py`: add `COMMAND_RESULT`.
- Modify `src/mycli/state/session_service.py`: append UI-only command history through one method.
- Modify `src/mycli/services/transcript_projection.py`: preserve bounded displays in session snapshots and TUI projection.
- Modify `src/mycli/cli/node_tui/gateway.py`: allocate stable result IDs, persist results, return semantic errors, and preserve mutation ordering.
- Create `src/mycli/services/legacy_slash_output.py`: upgrade old tagged output at the transcript-load boundary.

### TypeScript Runtime And TUI

- Create `tui/mycli-shell/src/adapters/command-results.ts`: strict version 1 display parser and fallback extraction.
- Modify `tui/mycli-shell/src/model.ts`: shared command result types and transcript block.
- Modify `tui/mycli-shell/src/adapters/runtime-state.ts`: live upsert by result ID and resumed command-result projection.
- Create `tui/mycli-shell/src/components/command-result.ts`: semantic result router and all static command renderers.
- Modify `tui/mycli-shell/src/shell-app.ts`: render command result blocks.
- Modify `tui/mycli-shell/src/shell-runtime.ts`: update command result components in place and expand bounded lists.
- Modify `tui/mycli-shell/src/gateway.ts`: session-switch ordering and stable result upsert.
- Modify `tui/mycli-shell/test/support/scripted-client.ts`: consume the structured result through the shared adapter.

---

### Task 1: Add The Typed Command Display Contract

**Files:**
- Create: `src/mycli/cli/slash_command_result.py`
- Create: `tests/unit/cli/test_slash_command_result.py`

- [ ] **Step 1: Write failing serialization and text projection tests**

Create `tests/unit/cli/test_slash_command_result.py` with focused cases for every display kind:

```python
from mycli.cli.slash_command_result import (
    SlashCommandDisplay,
    SlashCommandDisplayKind,
    SlashCommandField,
    SlashCommandRow,
    SlashCommandSection,
    SlashCommandSeverity,
    render_slash_command_text,
)


def test_status_display_serializes_as_versioned_bounded_payload() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.STATUS,
        command="/status",
        title="mycli",
        fields=(
            SlashCommandField(label="Model", value="gpt-5.4"),
            SlashCommandField(label="Directory", value="/repo/mycli"),
        ),
    )

    assert display.to_payload() == {
        "version": 1,
        "kind": "status",
        "command": "/status",
        "title": "mycli",
        "severity": "info",
        "fields": [
            {"label": "Model", "value": "gpt-5.4"},
            {"label": "Directory", "value": "/repo/mycli"},
        ],
    }


def test_list_text_projection_is_deterministic_and_ansi_free() -> None:
    display = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.LIST,
        command="/tools",
        title="Tools",
        summary="2 available",
        rows=(
            SlashCommandRow(key="Read", label="Read", values=("file", "auto allow"), status="available"),
            SlashCommandRow(key="Shell", label="Shell", values=("shell", "asks approval"), status="warning"),
        ),
    )

    assert render_slash_command_text(display) == (
        "Tools - 2 available",
        "Read  file  auto allow",
        "Shell  shell  asks approval",
    )


def test_error_display_rejects_success_severity() -> None:
    try:
        SlashCommandDisplay(
            kind=SlashCommandDisplayKind.ERROR,
            command="/memory add",
            title="Invalid command",
            severity=SlashCommandSeverity.SUCCESS,
        )
    except ValueError as exc:
        assert str(exc) == "error displays cannot use success severity"
    else:
        raise AssertionError("expected invalid error severity")


def test_preformatted_display_bounds_text_and_reports_omission() -> None:
    display = SlashCommandDisplay.preformatted_result(
        command="/trace logs",
        title="Trace logs",
        text="x" * 20_000,
    )

    payload = display.to_payload()
    assert len(str(payload["preformatted"])) <= 8_000
    assert int(payload["omitted_chars"]) > 0


def test_display_payload_round_trips_through_validation() -> None:
    original = SlashCommandDisplay(
        kind=SlashCommandDisplayKind.NOTICE,
        command="/undo",
        title="Undo complete",
        severity=SlashCommandSeverity.SUCCESS,
        summary="Restored app.py",
    )

    assert SlashCommandDisplay.from_payload(original.to_payload()) == original
```

Add equivalent assertions for diagnostic fields/sections, success notices, row omission, and empty optional-field omission.

- [ ] **Step 2: Run the contract tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/cli/test_slash_command_result.py -q
```

Expected: collection fails because `mycli.cli.slash_command_result` does not exist.

- [ ] **Step 3: Implement immutable display types and text projection**

Create `src/mycli/cli/slash_command_result.py` with:

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

DISPLAY_VERSION = 1
MAX_TEXT_CHARS = 8_000
MAX_ROWS = 100
MAX_SECTIONS = 16


class SlashCommandDisplayKind(StrEnum):
    STATUS = "status"
    DIAGNOSTIC = "diagnostic"
    LIST = "list"
    NOTICE = "notice"
    ERROR = "error"
    PREFORMATTED = "preformatted"


class SlashCommandSeverity(StrEnum):
    INFO = "info"
    SUCCESS = "success"
    WARNING = "warning"
    ERROR = "error"


@dataclass(frozen=True, slots=True)
class SlashCommandField:
    label: str
    value: str
    tone: str | None = None


@dataclass(frozen=True, slots=True)
class SlashCommandRow:
    key: str
    label: str
    values: tuple[str, ...] = ()
    status: str | None = None
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class SlashCommandSection:
    title: str
    fields: tuple[SlashCommandField, ...] = ()
    rows: tuple[SlashCommandRow, ...] = ()
```

Implement `SlashCommandDisplay` with the fields from the design, default
`version=DISPLAY_VERSION`, `__post_init__` validation, `to_payload()`,
`from_payload()`, and `preformatted_result()`. `from_payload()` accepts only a
mapping with version 1 and complete nested field/row/section shapes. Bound every
string through one private `_bounded_text()` helper, cap rows and sections, and
compute `omitted_rows` and `omitted_chars` before serialization.

Implement `render_slash_command_text(display) -> tuple[str, ...]` with exact branch behavior:

- status and diagnostic: title, summary when present, then `Label: Value` fields and section fields;
- list: `Title - Summary`, then double-space-separated row label and values;
- notice: summary or title;
- error: `Error: <summary-or-title>`, `Usage: ...`, then `Did you mean: ...`;
- preformatted: split bounded preformatted text into lines.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
uv run pytest tests/unit/cli/test_slash_command_result.py -q
uv run ruff check src/mycli/cli/slash_command_result.py tests/unit/cli/test_slash_command_result.py
uv run mypy src/mycli/cli/slash_command_result.py
```

Expected: all tests pass and both static checks report no errors.

- [ ] **Step 5: Commit the result contract**

```bash
git add src/mycli/cli/slash_command_result.py tests/unit/cli/test_slash_command_result.py
git commit -m "feat: add typed slash command results"
```

---

### Task 2: Add Command-Family Presenters

**Files:**
- Create: `src/mycli/cli/slash_command_presenters.py`
- Create: `tests/unit/cli/test_slash_command_presenters.py`

- [ ] **Step 1: Write failing presenter tests for the four acceptance examples**

Create `tests/unit/cli/test_slash_command_presenters.py`:

```python
from mycli.cli.slash_command_presenters import (
    present_error,
    present_list,
    present_notice,
    present_status,
)


def test_status_presenter_builds_named_fields() -> None:
    display = present_status(
        command="/status",
        values=(
            "session=demo model=gpt-5.4 provider=openai/responses",
            "context=32.8% pending=no suspended=no",
        ),
        directory="/repo/mycli",
    )

    assert display.kind.value == "status"
    assert [(field.label, field.value) for field in display.fields] == [
        ("Session", "demo"),
        ("Model", "gpt-5.4"),
        ("Provider", "openai/responses"),
        ("Directory", "/repo/mycli"),
        ("Context", "32.8%"),
    ]


def test_list_presenter_keeps_unknown_tokens_as_detail() -> None:
    display = present_list(
        command="/tools",
        title="Tools",
        values=("Read source=builtin toolset=file extra-token",),
        row_prefix="tool",
    )

    assert display.rows[0].label == "Read"
    assert display.rows[0].values == ("builtin", "file")
    assert display.rows[0].detail == "extra-token"


def test_notice_names_the_affected_object() -> None:
    display = present_notice(
        command="/undo",
        title="Undo complete",
        summary="Restored src/mycli/app.py",
    )
    assert display.severity.value == "success"
    assert display.summary == "Restored src/mycli/app.py"


def test_error_includes_usage_and_registry_suggestions() -> None:
    display = present_error(
        command="/memroy",
        reason="Unknown command /memroy",
        usage=None,
        suggestions=("/memory",),
    )
    assert display.kind.value == "error"
    assert display.suggestions == ("/memory",)
```

Add diagnostic tests for usage and context service rows and a preformatted trace test.

- [ ] **Step 2: Run presenter tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/cli/test_slash_command_presenters.py -q
```

Expected: collection fails because the presenter module does not exist.

- [ ] **Step 3: Implement the bounded migration tokenizer and presenters**

Create `src/mycli/cli/slash_command_presenters.py` with these public functions:

```python
def present_status(*, command: str, values: tuple[str, ...], directory: str | None) -> SlashCommandDisplay: ...
def present_diagnostic(*, command: str, title: str, values: tuple[str, ...]) -> SlashCommandDisplay: ...
def present_list(*, command: str, title: str, values: tuple[str, ...], row_prefix: str) -> SlashCommandDisplay: ...
def present_notice(*, command: str, title: str, summary: str, severity: SlashCommandSeverity = SlashCommandSeverity.SUCCESS) -> SlashCommandDisplay: ...
def present_error(*, command: str, reason: str, usage: str | None, suggestions: tuple[str, ...] = ()) -> SlashCommandDisplay: ...
def present_preformatted(*, command: str, title: str, values: tuple[str, ...]) -> SlashCommandDisplay: ...
```

Use `shlex.split()` in a private `_tokenize_service_row()` function. Split only the first `=` in each token, preserve non-key/value tokens as detail, and use command-specific field order maps. Do not expose tagged prefixes in the resulting display.

- [ ] **Step 4: Run presenter tests and static checks**

Run:

```bash
uv run pytest tests/unit/cli/test_slash_command_presenters.py -q
uv run ruff check src/mycli/cli/slash_command_presenters.py tests/unit/cli/test_slash_command_presenters.py
uv run mypy src/mycli/cli/slash_command_presenters.py
```

Expected: all pass.

- [ ] **Step 5: Commit the presenters**

```bash
git add src/mycli/cli/slash_command_presenters.py tests/unit/cli/test_slash_command_presenters.py
git commit -m "feat: add slash command result presenters"
```

---

### Task 3: Migrate Backend Dispatch To Structured Displays

**Files:**
- Modify: `src/mycli/cli/slash_command_dispatch.py`
- Modify: `src/mycli/cli/slash_command_registry.py`
- Modify: `src/mycli/cli/repl.py`
- Modify: `tests/unit/cli/test_slash_command_dispatch.py`
- Modify: `tests/unit/cli/test_slash_command_registry.py`
- Modify: `tests/unit/cli/test_main.py`

- [ ] **Step 1: Replace tagged-line expectations with display-family expectations**

Update `tests/unit/cli/test_slash_command_dispatch.py` so canonical commands and aliases assert one structured contract:

```python
def test_short_canonical_commands_and_hidden_aliases_share_display() -> None:
    service = fake_service()
    usage = dispatch_backend_slash_command(service, resolve_cli("/usage"))
    legacy = dispatch_backend_slash_command(service, resolve_cli("/status usage"))

    assert usage.display == legacy.display
    assert usage.display.kind.value == "diagnostic"
    assert usage.lines == legacy.lines


def test_backend_commands_cover_every_result_family() -> None:
    service = fake_service()
    assert dispatch_backend_slash_command(service, resolve_cli("/status")).display.kind.value == "status"
    assert dispatch_backend_slash_command(service, resolve_cli("/tools")).display.kind.value == "list"
    assert dispatch_backend_slash_command(service, resolve_cli("/undo")).display.kind.value == "notice"
    assert dispatch_backend_slash_command(service, resolve_cli("/trace logs")).display.kind.value == "preformatted"
```

Extend `fake_service()` with `inspect_status`, `inspect_tools`, and `inspect_logs`
callables before adding this matrix:

```python
inspect_status=lambda: ("session=demo model=gpt-test provider=test",),
inspect_tools=lambda: ("Read source=builtin toolset=file",),
inspect_logs=lambda: ("gateway ready",),
```

Update payload assertions to require `display` and to assert that `lines` equal `render_slash_command_text(result.display)`.

In `tests/unit/cli/test_slash_command_registry.py`, assert backend inspection commands now resolve with `presentation=TRANSCRIPT`, while bare TUI selectors remain `OVERLAY`.

Add a registry-owned suggestion test:

```python
def test_slash_command_suggestions_use_visible_canonical_names() -> None:
    context = SlashCommandContext(surface=SlashCommandSurface.CLI)
    assert slash_command_suggestions("/memroy", context) == ("/memory",)
    assert "/status usage" not in slash_command_suggestions("/usag", context)
```

- [ ] **Step 2: Run dispatch and registry tests to verify old behavior fails**

Run:

```bash
uv run pytest tests/unit/cli/test_slash_command_dispatch.py tests/unit/cli/test_slash_command_registry.py -q
```

Expected: failures show missing `display` and old overlay presentation values.

- [ ] **Step 3: Make `display` primary in `SlashCommandResult`**

Modify `SlashCommandResult`:

```python
@dataclass(frozen=True)
class SlashCommandResult:
    display: SlashCommandDisplay
    presentation: SlashCommandPresentation = SlashCommandPresentation.TRANSCRIPT
    # existing mutation/control fields remain unchanged

    @property
    def lines(self) -> tuple[str, ...]:
        return render_slash_command_text(self.display)

    def to_payload(self, *, result_id: str | None = None) -> dict[str, object]:
        payload = {
            "execution": "backend",
            "display": self.display.to_payload(),
            "lines": list(self.lines),
            "presentation": self.presentation.value,
            # existing control fields
        }
        if result_id:
            payload["result_id"] = result_id
        return payload
```

Replace `_lines()` and every tagged tuple in dispatch with the presenter matching the command family. Keep `/ps` processes and control flags unchanged, but also attach a display fallback. Build `/status` through `present_status()` and pass the configured workspace path when available.

- [ ] **Step 4: Normalize registry presentation ownership**

Change backend inspection and mutation commands to `SlashCommandPresentation.TRANSCRIPT`. Keep TUI-owned bare commands at `OVERLAY` and `/quit` at `NONE`. Preserve existing command order, aliases, and surface filtering.

Add `slash_command_suggestions(text, context)` to the registry. It uses
`difflib.get_close_matches()` over visible canonical manifest names, returns at
most three names, and never exposes aliases.

- [ ] **Step 5: Update CLI expectations and run focused suites**

Update `build_command_handler()` in `src/mycli/cli/repl.py` so resolution failures
use `present_error()`, `slash_command_suggestions()`, and
`render_slash_command_text()` rather than returning a second error format. Update
`tests/unit/cli/test_main.py` and `tests/integration/test_cli_repl.py` expected lines
to the deterministic text projection. Run:

```bash
uv run pytest \
  tests/unit/cli/test_slash_command_dispatch.py \
  tests/unit/cli/test_slash_command_registry.py \
  tests/unit/cli/test_main.py \
  tests/integration/test_cli_repl.py -q
uv run ruff check src/mycli/cli tests/unit/cli tests/integration/test_cli_repl.py
uv run mypy src/mycli/cli
```

Expected: all pass.

- [ ] **Step 6: Commit structured dispatch**

```bash
git add src/mycli/cli/slash_command_dispatch.py src/mycli/cli/slash_command_registry.py src/mycli/cli/repl.py tests/unit/cli/test_slash_command_dispatch.py tests/unit/cli/test_slash_command_registry.py tests/unit/cli/test_main.py tests/integration/test_cli_repl.py
git commit -m "refactor: return structured slash command displays"
```

---

### Task 4: Persist UI-Only Command Results

**Files:**
- Modify: `src/mycli/domain/runtime/session_history.py`
- Modify: `src/mycli/state/session_service.py`
- Modify: `src/mycli/services/transcript_projection.py`
- Modify: `tests/unit/services/test_session_service.py`
- Modify: `tests/unit/services/test_transcript_projection.py`
- Modify: `tests/unit/services/test_context_manager.py`
- Modify: `tests/unit/services/test_turn_context_assembler.py`

- [ ] **Step 1: Write failing command-result persistence and context-exclusion tests**

Add a projection test:

```python
def test_command_result_is_visible_to_tui_but_not_rewritten() -> None:
    item = HistoryItem(
        id="command-1",
        thread_id="demo",
        turn_id="command-1",
        type=HistoryItemType.COMMAND_RESULT,
        text="Tools - 1 available",
        metadata={
            "command": "/tools",
            "model_visible": False,
            "display": {
                "version": 1,
                "kind": "list",
                "command": "/tools",
                "title": "Tools",
                "severity": "info",
                "rows": [{"key": "Read", "label": "Read", "values": ["file"]}],
            },
        },
    )

    snapshot = project_history_items_for_snapshot((item,))[0].to_dict()
    assert snapshot["type"] == "command_result"
    assert snapshot["metadata"]["display"]["kind"] == "list"
    assert project_history_item_for_tui(item)["type"] == "command_result"
```

Add context manager and turn context assembler tests that place `COMMAND_RESULT` between user and assistant items and assert the generated provider messages contain neither the result text nor its display metadata.

- [ ] **Step 2: Run persistence tests and verify they fail**

Run:

```bash
uv run pytest \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_context_manager.py \
  tests/unit/services/test_turn_context_assembler.py -q
```

Expected: enum construction fails because `COMMAND_RESULT` is absent.

- [ ] **Step 3: Add history type and bounded snapshot projection**

Add `COMMAND_RESULT = "command_result"` to `HistoryItemType`. Include it in `_VISIBLE_HISTORY_TYPES`, map it to snapshot and TUI type `command_result`, and retain only these command metadata keys:

```python
{"command", "display", "model_visible", "created_at", "folded"}
```

Validate and bound the persisted display through the command result serializer before writing it to `session.json`. Do not add `COMMAND_RESULT` to provider history maps; the existing context loops must continue to skip it through their final `else` branch.

- [ ] **Step 4: Add one SessionService append method**

Add:

```python
def append_command_result(
    self,
    *,
    session_id: str,
    result_id: str,
    command: str,
    text: str,
    display: dict[str, object],
) -> None:
    self.append_history_items(
        session_id,
        (
            HistoryItem(
                id=result_id,
                thread_id=session_id,
                turn_id=result_id,
                type=HistoryItemType.COMMAND_RESULT,
                text=text,
                metadata={
                    "command": command,
                    "display": display,
                    "model_visible": False,
                },
            ),
        ),
    )
```

Test that this method updates canonical history and the formatted `session.json` transcript.

- [ ] **Step 5: Run persistence and context suites**

Run:

```bash
uv run pytest \
  tests/unit/services/test_session_service.py \
  tests/unit/services/test_transcript_projection.py \
  tests/unit/services/test_context_manager.py \
  tests/unit/services/test_turn_context_assembler.py -q
uv run ruff check src/mycli/domain/runtime/session_history.py src/mycli/state/session_service.py src/mycli/services/transcript_projection.py tests/unit/services
uv run mypy src/mycli/domain/runtime/session_history.py src/mycli/state/session_service.py src/mycli/services/transcript_projection.py
```

Expected: all pass and command text is absent from model-message assertions.

- [ ] **Step 6: Commit UI-only persistence**

```bash
git add src/mycli/domain/runtime/session_history.py src/mycli/state/session_service.py src/mycli/services/transcript_projection.py tests/unit/services/test_session_service.py tests/unit/services/test_transcript_projection.py tests/unit/services/test_context_manager.py tests/unit/services/test_turn_context_assembler.py
git commit -m "feat: persist slash command results outside model context"
```

---

### Task 5: Add Stable Gateway Results And Semantic Command Errors

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tests/unit/domain/runtime/test_gateway_contract.py`

- [ ] **Step 1: Write failing Gateway tests for IDs, persistence, and suggestions**

Add tests asserting:

```python
def test_gateway_command_run_returns_and_persists_one_stable_result(tmp_path: Path) -> None:
    service = FakeService(tmp_path)
    gateway = NodeTuiGateway(service=service)

    response = gateway.handle_request(
        RpcRequest(id="cmd", method="command.run", params={"command": "/tools"})
    )

    assert response.result is not None
    result_id = str(response.result["result_id"])
    assert result_id.startswith("command:")
    assert response.result["display"]["kind"] == "list"
    saved = service.fake_session_service.load_history_items("demo")
    assert [item.id for item in saved if item.type is HistoryItemType.COMMAND_RESULT] == [result_id]


def test_unknown_command_returns_compact_error_display(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))
    response = gateway.handle_request(
        RpcRequest(id="bad", method="command.run", params={"command": "/memroy"})
    )

    assert response.error is None
    assert response.result is not None
    assert response.result["display"]["kind"] == "error"
    assert response.result["display"]["suggestions"] == ["/memory"]
```

Add tests for persistence failure returning the display plus one bounded warning event, `/quit` not persisting, and TUI `client_action` not persisting.

- [ ] **Step 2: Run Gateway tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py -q
```

Expected: failures show missing `result_id`, no command history, and unknown command still becoming an RPC error.

- [ ] **Step 3: Allocate, persist, and serialize result IDs**

In `_handle_command_run()`:

```python
origin_session_id = self.service._config.session_id
result = dispatch_backend_slash_command(...)
result_id = f"command:{uuid4().hex}"
command_text = " ".join(
    part for part in (invocation.canonical_name, invocation.args) if part
)

if result.presentation is SlashCommandPresentation.TRANSCRIPT and not result.mutated_session:
    try:
        self.service._session_service.append_command_result(
            session_id=origin_session_id,
            result_id=result_id,
            command=command_text,
            text="\n".join(result.lines),
            display=result.display.to_payload(),
        )
    except (OSError, sqlite3.Error) as exc:
        self._emit_gateway_error(
            code="command_result_persistence_failed",
            message="Command result could not be saved; it remains visible in this session.",
            detail=str(exc),
            method="command.run",
        )

return result.to_payload(result_id=result_id)
```

Allocate and return `result_id` only for transcript-presented results. `/quit`,
TUI actions, and transient session-switch notices do not receive a persisted result
ID.

- [ ] **Step 4: Convert resolution failures to semantic error results**

Catch `SlashCommandError` only inside `_handle_command_run`. Return an error
display with generated lines and no RPC error. Keep malformed JSON-RPC params and
invalid surface values as protocol errors.

Use the registry's `slash_command_suggestions()` helper rather than implementing a
second fuzzy matcher in Gateway. For a successful session mutation, add
`session_id=self.service._config.session_id` to the control payload after dispatch.

- [ ] **Step 5: Run Gateway contract and static checks**

Run:

```bash
uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q
uv run ruff check src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py
uv run mypy src/mycli/cli/node_tui/gateway.py
```

Expected: all pass.

- [ ] **Step 6: Commit Gateway result persistence**

```bash
git add src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py
git commit -m "feat: persist structured gateway command results"
```

---

### Task 6: Parse And Project Structured Results In TypeScript

**Files:**
- Create: `tui/mycli-shell/src/adapters/command-results.ts`
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Create: `tui/mycli-shell/test/command-results.test.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Write failing strict-parser and reducer tests**

Create `test/command-results.test.ts`:

```typescript
test("command result parser accepts version one and rejects partial rows", () => {
	const parsed = commandResultFromGateway({
		result_id: "command:1",
		display: {
			version: 1,
			kind: "list",
			command: "/tools",
			title: "Tools",
			severity: "info",
			rows: [{ key: "Read", label: "Read", values: ["file"] }],
		},
		lines: ["Tools", "Read  file"],
	});

	assert.equal(parsed?.id, "command:1");
	assert.equal(parsed?.display.kind, "list");
	assert.equal(parsed?.display.rows[0]?.label, "Read");
	assert.equal(commandResultFromGateway({ display: { version: 2 } }), null);
});
```

Add runtime-state tests that apply the same result ID twice and assert one transcript item, then load a resumed `command_result` with the same ID and assert one projected block.

- [ ] **Step 2: Run focused Node tests and verify they fail**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/command-results.test.ts test/runtime-state.test.ts
```

Expected: imports and `command_result` transcript type fail.

- [ ] **Step 3: Add TypeScript command result types and strict parser**

Add model types matching Python field names after camel-case projection:

```typescript
export type MycliShellCommandResult = {
	id: string;
	display: {
		version: 1;
		kind: "status" | "diagnostic" | "list" | "notice" | "error" | "preformatted";
		command: string;
		title: string;
		severity: "info" | "success" | "warning" | "error";
		summary?: string;
		fields: MycliShellCommandField[];
		rows: MycliShellCommandRow[];
		sections: MycliShellCommandSection[];
		usage?: string;
		suggestions: string[];
		preformatted?: string;
		totalRows?: number;
		omittedRows: number;
	};
	fallbackLines: string[];
	folded: boolean;
};
```

Create `command-results.ts` with `commandResultFromGateway()` and `commandResultFromTranscriptItem()`. Require version 1, valid kind/severity, string command/title, and complete row/field shapes. Bound arrays again client-side. Return `null` for unsupported versions so callers can use fallback lines.

- [ ] **Step 4: Replace live line parsing with stable-ID upsert**

Change `runtimeStateWithCommandResult()` to parse `display`, create type `command_result`, and upsert by `result_id`. Preserve the current dedicated `/ps` process branch. In `projectRuntimeState()`, map `command_result` to `{ kind: "command_result", commandResult }`.

Do not delete old usage/context parsing yet; move it in Task 8 after the legacy load adapter exists.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/command-results.test.ts test/runtime-state.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit TypeScript contract support**

```bash
git add tui/mycli-shell/src/adapters/command-results.ts tui/mycli-shell/src/model.ts tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/test/command-results.test.ts tui/mycli-shell/test/runtime-state.test.ts
git commit -m "feat: project structured slash command results"
```

---

### Task 7: Render Codex-Style Semantic Command Components

**Files:**
- Create: `tui/mycli-shell/src/components/command-result.ts`
- Modify: `tui/mycli-shell/src/components/command-diagnostic.ts`
- Modify: `tui/mycli-shell/src/shell-app.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/index.ts`
- Create: `tui/mycli-shell/test/command-result-component.test.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing visual acceptance tests**

Create `test/command-result-component.test.ts` with `/status`, `/tools`, `/undo`, and invalid `/memory add` fixtures. Assert plain rendered output:

```typescript
test("status uses the only bordered command surface", () => {
	const output = stripAnsi(new CommandResultComponent(statusResult()).render(80).join("\n"));
	assert.match(output, /╭─+/);
	assert.match(output, /Model\s+gpt-5\.4/);
	assert.match(output, /Directory\s+\/repo\/mycli/);
});

test("list and notice results stay borderless and compact", () => {
	const tools = stripAnsi(new CommandResultComponent(toolsResult()).render(100).join("\n"));
	const undo = stripAnsi(new CommandResultComponent(undoResult()).render(100).join("\n"));
	assert.match(tools, /Tools\s+2 available/);
	assert.match(tools, /Read\s+file\s+auto allow/);
	assert.doesNotMatch(tools, /╭|╰/);
	assert.equal(undo.trim(), "✓ Restored src/mycli/app.py");
});
```

Add 60/100/160 width assertions using `visibleWidth`, CJK fields, long paths, eight-row collapse with `... N more`, empty list text, preformatted head/tail omission, and no `USE|CTX|CMD` abbreviations.

- [ ] **Step 2: Run component tests and verify they fail**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/command-result-component.test.ts
```

Expected: `CommandResultComponent` is missing.

- [ ] **Step 3: Implement one router with focused private renderers**

Create `CommandResultComponent extends Container`. Route by `display.kind` to private status, diagnostic, list, notice, error, and preformatted builders. Reuse `CommandDiagnosticComponent` after changing it to accept the shared display fields and sections. Use existing `theme` semantic tokens, `visibleWidth`, and truncation helpers; do not use raw string length.

Exact visual rules:

- status: one rounded single-line border, maximum 76 visible columns, two-space inner padding;
- diagnostic: title, metric line, named sections, no abbreviations;
- list: title plus dim summary, at most eight rows while folded, aligned visible columns;
- notice: `✓` success, `!` warning/error, no border;
- error: reason then indented usage and suggestions;
- preformatted: preserve line breaks and show omission line.

- [ ] **Step 4: Wire transcript rendering and in-place updates**

Add `command_result` branches to `TranscriptBlocksComponent` and `MycliShellRuntime.create/syncChatBlock()`. Cache the component by transcript ID and call `updateResult()` on live replacement. Extend the existing detail toggle to invert `folded` for command list blocks without changing status or notice blocks.

- [ ] **Step 5: Run TUI visual and runtime tests**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test \
  test/command-result-component.test.ts \
  test/shell-app.test.ts \
  test/runtime-state.test.ts
npm run typecheck
```

Expected: all pass and every rendered line remains within the requested width.

- [ ] **Step 6: Commit semantic command rendering**

```bash
git add tui/mycli-shell/src/components/command-result.ts tui/mycli-shell/src/components/command-diagnostic.ts tui/mycli-shell/src/shell-app.ts tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/src/index.ts tui/mycli-shell/test/command-result-component.test.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: render Codex-style slash command results"
```

---

### Task 8: Add Legacy Resume Conversion And Session-Switch Ordering

**Files:**
- Create: `src/mycli/services/legacy_slash_output.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Create: `tests/unit/services/test_legacy_slash_output.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`
- Modify: `tui/mycli-shell/test/gateway-client.test.ts`
- Modify: `tui/mycli-shell/test/support/scripted-client.ts`

- [ ] **Step 1: Write failing legacy fixtures and session-switch tests**

Python fixtures must cover recognized `[status]`, `[usage]`, `[tool]`, `[permission]`, `[undo]`, malformed quoted values, unknown tags, and exact text fallback.

Gateway transcript-load tests must feed legacy history and snapshot items through
Python projection and assert the response contains a versioned `command_result`.
TypeScript runtime tests consume that projected item and assert equivalent live and
resumed blocks. A malformed legacy item remains an ordinary system message.

Gateway client tests must assert inline `/resume demo-2` performs:

```text
command.run -> transcript.load(demo-2) -> one transient notice
```

and does not leave the source transcript in the destination state.

The fixture response includes `mutated_session: true` and `session_id: "demo-2"`.
If the returned session ID equals the current session, the client keeps the current
transcript and shows only the normal command result.

- [ ] **Step 2: Run compatibility tests and verify they fail**

Run:

```bash
uv run pytest tests/unit/services/test_legacy_slash_output.py tests/unit/cli/node_tui/test_gateway.py -q
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/runtime-state.test.ts test/gateway-client.test.ts
```

Expected: legacy modules and session-switch sequence are absent.

- [ ] **Step 3: Implement Python legacy conversion at transcript load**

Create `legacy_slash_output.py` with:

```python
LEGACY_TAGS = frozenset({
    "status", "usage", "context", "stats", "tool", "skill", "agent",
    "permission", "change", "memory", "mode", "sandbox", "undo", "bash",
})

def legacy_slash_display(*, command: str, lines: tuple[str, ...]) -> SlashCommandDisplay | None:
    ...
```

Use the same bounded tokenizer as presenters, require every line to have one recognized tag, select the family from the tag set, and return `None` on unsafe or mixed input. Call it only while projecting transcript/snapshot items that do not already contain a versioned display. Never rewrite source history.

- [ ] **Step 4: Remove TypeScript tagged-line parsing from live and resume paths**

Delete `canonicalDiagnosticCommand`, `usageDiagnosticFromLines`,
`contextDiagnosticFromLines`, and their tagged-line helpers from
`runtime-state.ts`. Live and resumed structured items both use
`commandResultFromTranscriptItem()`. If Python leaves a legacy item unchanged, the
TUI retains its original system-message text without reparsing it.

- [ ] **Step 5: Implement destination-first session switching**

In `runCommand()`, when result indicates `mutated_session`, read the destination session ID from the response, clear the old transcript, load the destination transcript, update runtime state, and append a transient notice through the runtime rather than `runtimeStateWithCommandResult()`. Do not persist that notice. Preserve existing bare `/resume` selector behavior.

Update scripted and native clients to use structured fallback lines without implementing their own display parser.

- [ ] **Step 6: Run compatibility, integration, and type checks**

Run:

```bash
uv run pytest tests/unit/services/test_legacy_slash_output.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all pass, legacy and new live fixtures project equivalently, and no duplicate result appears after resume.

- [ ] **Step 7: Commit compatibility and session switching**

```bash
git add src/mycli/services/legacy_slash_output.py src/mycli/cli/node_tui/gateway.py tests/unit/services/test_legacy_slash_output.py tests/unit/cli/node_tui/test_gateway.py tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/src/gateway.ts tui/mycli-shell/test/runtime-state.test.ts tui/mycli-shell/test/gateway-client.test.ts tui/mycli-shell/test/support/scripted-client.ts
git commit -m "feat: restore structured slash results across sessions"
```

---

### Task 9: Remove Duplicate Parsing And Run Cross-Layer Verification

**Files:**
- Modify only files exposed by verification failures.

- [ ] **Step 1: Add the final command-surface matrix test**

Add one parameterized Python test that resolves every canonical backend command with a complete fake service and asserts:

```python
assert result.display.version == 1
assert result.lines == render_slash_command_text(result.display)
assert "[status]" not in "\n".join(result.lines)
assert "[tool]" not in "\n".join(result.lines)
```

Explicitly assert the expected family for `/status`, `/usage`, `/context`, `/stats`, `/tools`, `/skills`, `/agents`, `/permissions`, `/changes`, `/memory`, `/undo`, `/stop`, and `/trace logs`.

- [ ] **Step 2: Run focused Python tests**

Run:

```bash
uv run pytest \
  tests/unit/cli/test_slash_command_result.py \
  tests/unit/cli/test_slash_command_presenters.py \
  tests/unit/cli/test_slash_command_dispatch.py \
  tests/unit/cli/test_slash_command_registry.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/unit/services/test_legacy_slash_output.py \
  tests/unit/services/test_transcript_projection.py \
  tests/integration/test_cli_repl.py \
  tests/integration/test_node_tui_gateway.py -q
```

Expected: pass.

- [ ] **Step 3: Run complete Python quality checks**

Run:

```bash
uv run pytest -q
uv run ruff check src tests
uv run mypy src
```

Expected: all Python tests pass, Ruff reports no errors, and mypy reports success.

- [ ] **Step 4: Run complete TypeScript checks**

Run:

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all Node tests pass and TypeScript typechecking succeeds.

- [ ] **Step 5: Audit protocol and legacy boundaries**

Run:

```bash
! rg -n "commandDiagnosticFromLines|canonicalDiagnosticCommand|usageDiagnosticFromLines|contextDiagnosticFromLines" tui/mycli-shell/src
! rg -n "\[(status|usage|context|stats|tool|skill|agent|permission|change|memory|mode|sandbox|undo)\]" src/mycli/cli
! rg -n "COMMAND_RESULT" src/mycli/services/context src/mycli/application/runtime/request
```

Expected:

- no tagged command-line parser remains in TypeScript;
- tagged output strings exist only in legacy fixtures/adapters, not new dispatch;
- no model-context module explicitly includes `COMMAND_RESULT`.

- [ ] **Step 6: Verify the four visual acceptance examples**

Run the component test directly and inspect its plain snapshots:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/command-result-component.test.ts
```

Confirm `/status` is the only bordered general command surface, `/tools` is aligned and borderless, `/undo` is one compact success line, and invalid `/memory add` includes canonical usage.

- [ ] **Step 7: Commit verification-only fixes when needed**

If verification changes code or tests, stage only the slash result files and commit:

```bash
git commit -m "test: verify structured slash command results"
```

If verification produces no changes, do not create an empty commit.
