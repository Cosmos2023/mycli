# Codex-Style Slash Command Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's divergent Python and TypeScript slash-command lists with one typed Python registry that drives CLI help, completion, Gateway dispatch, and the TUI command palette.

**Architecture:** A new Python registry owns command identity, display metadata, aliases, surface-specific dispatch policy, and availability. Backend execution moves behind typed command IDs; Gateway exposes the visible manifest through `command.list` and resolves every submitted slash command through `command.run`. The TypeScript TUI consumes the manifest and retains only a map of local `client_action` behavior.

**Tech Stack:** Python 3.13, dataclasses/StrEnum, pytest, JSON-RPC Gateway, TypeScript 5.9, Node test runner, custom TUI autocomplete/select-list components.

---

## File Map

- Create `src/mycli/cli/slash_command_registry.py`: command types, catalog, aliases, resolver, manifest projection, help generation, and integrity validation.
- Create `src/mycli/cli/slash_command_dispatch.py`: typed backend command handlers and structured command results.
- Modify `src/mycli/cli/repl.py`: keep only REPL control flow and delegate slash commands to the registry/dispatcher.
- Delete `src/mycli/cli/slash_commands.py`: remove the second Python command catalog after all consumers migrate.
- Modify `src/mycli/cli/node_tui/gateway.py`: add `command.list`, use typed resolution for `command.run`, and project legacy completion from the registry.
- Modify `src/mycli/domain/runtime/gateway_contract.py`: advertise `command.list`.
- Create `tests/unit/cli/test_slash_command_registry.py`: registry ordering, aliases, dispatch policy, validation, and errors.
- Create `tests/unit/cli/test_slash_command_dispatch.py`: typed backend dispatch coverage.
- Modify `tests/integration/test_cli_repl.py`: generated help, aliases, unknown commands, and CLI-only behavior.
- Modify `tests/unit/cli/node_tui/test_gateway.py`: manifest, TUI actions, backend results, completion compatibility, and turn-state enforcement.
- Create `tui/mycli-shell/src/adapters/slash-commands.ts`: validate `command.list` and `command.run` payloads.
- Create `tui/mycli-shell/test/slash-commands.test.ts`: payload parsing tests.
- Modify `tui/mycli-shell/src/model.ts`: command manifest and client-action result types.
- Modify `tui/mycli-shell/src/index.ts`: export the new public command type.
- Modify `tui/mycli-shell/src/gateway.ts`: load the manifest, route client actions, and remove injected static commands.
- Modify `tui/mycli-shell/src/shell-runtime.ts`: build palette/autocomplete from the manifest and centralize local action handling.
- Modify `tui/mycli-shell/src/native-chat-runtime.ts`: submit all slash commands through Gateway except the non-command `/` palette trigger, which native mode does not support.
- Modify `tui/mycli-shell/test/shell-app.test.ts`: command order, hidden aliases, unified submission, and client actions.
- Modify `tui/mycli-shell/test/native-chat-runtime.test.ts`: native slash-command routing.
- Modify `tui/mycli-shell/test/support/scripted-client.ts`: stop maintaining local `/help`, `/theme`, and session aliases.
- Modify `tests/unit/domain/runtime/test_gateway_contract.py`: include `command.list` in the protocol contract.

### Task 1: Add The Typed Registry And Resolver

**Files:**
- Create: `src/mycli/cli/slash_command_registry.py`
- Create: `tests/unit/cli/test_slash_command_registry.py`

- [ ] **Step 1: Write failing tests for the visible command surface**

```python
import pytest

from mycli.cli.slash_command_registry import (
    SlashCommandContext,
    SlashCommandError,
    SlashCommandId,
    SlashCommandOwner,
    SlashCommandSurface,
    command_manifest,
    resolve_slash_command,
    validate_slash_command_registry,
)


VISIBLE_TUI_NAMES = (
    "/model", "/plan", "/mode", "/permissions", "/sandbox", "/settings",
    "/resume", "/fork", "/new", "/status", "/usage", "/context", "/stats",
    "/skills", "/tools", "/resources", "/memory", "/agents", "/tasks",
    "/ps", "/stop", "/changes", "/undo", "/trace", "/details", "/view",
    "/hotkeys", "/copy", "/clear", "/login", "/trust", "/help", "/quit",
)


def tui_context(*, turn_running: bool = False) -> SlashCommandContext:
    return SlashCommandContext(surface=SlashCommandSurface.TUI, turn_running=turn_running)


def test_tui_manifest_has_one_ordered_canonical_command_surface() -> None:
    manifest = command_manifest(tui_context())
    assert tuple(item.name for item in manifest) == VISIBLE_TUI_NAMES
    assert all(item.description for item in manifest)
    assert "/status usage" not in VISIBLE_TUI_NAMES
    assert "/tasks bashes" not in VISIBLE_TUI_NAMES
    assert "/theme" not in VISIBLE_TUI_NAMES


def test_aliases_resolve_by_longest_prefix_without_becoming_visible() -> None:
    usage = resolve_slash_command("/status usage", tui_context())
    skills = resolve_slash_command("/tools skills", tui_context())
    fork = resolve_slash_command("/session fork old new 7", tui_context())
    assert usage.command_id is SlashCommandId.USAGE
    assert skills.command_id is SlashCommandId.SKILLS
    assert fork.command_id is SlashCommandId.FORK
    assert fork.args == "old new 7"


def test_surface_policy_selects_tui_bare_and_backend_inline_owner() -> None:
    bare = resolve_slash_command("/model", tui_context())
    inline = resolve_slash_command("/model gpt-5", tui_context())
    assert bare.owner is SlashCommandOwner.TUI
    assert bare.client_action == "open_model_selector"
    assert inline.owner is SlashCommandOwner.BACKEND
    assert inline.args == "gpt-5"


def test_registry_integrity_passes() -> None:
    validate_slash_command_registry()


def test_cli_manifest_hides_tui_only_commands_and_turn_policy_is_enforced() -> None:
    cli = SlashCommandContext(surface=SlashCommandSurface.CLI)
    assert "/settings" not in tuple(item.name for item in command_manifest(cli))
    with pytest.raises(SlashCommandError, match="disabled while a task is in progress"):
        resolve_slash_command("/resume", tui_context(turn_running=True))


def test_unknown_command_is_a_registry_error() -> None:
    with pytest.raises(SlashCommandError) as caught:
        resolve_slash_command("/does-not-exist", tui_context())
    assert caught.value.code == "unknown_command"
```

- [ ] **Step 2: Run the registry tests and verify they fail**

Run: `uv run pytest tests/unit/cli/test_slash_command_registry.py -q`

Expected: FAIL during collection because `mycli.cli.slash_command_registry` does not exist.

- [ ] **Step 3: Implement registry types and surface-specific dispatch policies**

Create these stable public types in `slash_command_registry.py`:

```python
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
import sys


class SlashCommandId(StrEnum):
    HELP = "help"
    MODEL = "model"
    PLAN = "plan"
    MODE = "mode"
    PERMISSIONS = "permissions"
    SANDBOX = "sandbox"
    SETTINGS = "settings"
    RESUME = "resume"
    FORK = "fork"
    NEW = "new"
    STATUS = "status"
    USAGE = "usage"
    CONTEXT = "context"
    STATS = "stats"
    SKILLS = "skills"
    TOOLS = "tools"
    RESOURCES = "resources"
    MEMORY = "memory"
    AGENTS = "agents"
    TASKS = "tasks"
    PS = "ps"
    STOP = "stop"
    CHANGES = "changes"
    UNDO = "undo"
    TRACE = "trace"
    DETAILS = "details"
    VIEW = "view"
    HOTKEYS = "hotkeys"
    COPY = "copy"
    CLEAR = "clear"
    LOGIN = "login"
    TRUST = "trust"
    QUIT = "quit"
    SESSION_SEARCH = "session_search"
    SESSION_MAINTENANCE = "session_maintenance"


class SlashCommandOwner(StrEnum):
    BACKEND = "backend"
    TUI = "tui"


class SlashCommandSurface(StrEnum):
    CLI = "cli"
    TUI = "tui"


class SlashArgumentPolicy(StrEnum):
    NONE = "none"
    OPTIONAL = "optional"
    REQUIRED = "required"


class SlashCommandPresentation(StrEnum):
    NONE = "none"
    OVERLAY = "overlay"
    TRANSCRIPT = "transcript"


@dataclass(frozen=True)
class SlashDispatchPolicy:
    bare_owner: SlashCommandOwner
    inline_owner: SlashCommandOwner | None = None
    bare_client_action: str | None = None
    inline_client_action: str | None = None


@dataclass(frozen=True)
class SlashCommandContext:
    surface: SlashCommandSurface
    turn_running: bool = False
    platform: str = sys.platform
    enabled_features: frozenset[str] = frozenset()


@dataclass(frozen=True)
class SlashCommandSpec:
    id: SlashCommandId
    name: str
    description: str
    argument_hint: str | None
    aliases: tuple[str, ...]
    argument_policy: SlashArgumentPolicy
    dispatch_by_surface: Mapping[SlashCommandSurface, SlashDispatchPolicy]
    presentation: SlashCommandPresentation
    available_during_turn: bool
    surfaces: frozenset[SlashCommandSurface]
    platforms: frozenset[str] | None = None
    feature: str | None = None


@dataclass(frozen=True)
class SlashCommandManifestItem:
    id: str
    name: str
    description: str
    argument_hint: str | None
    argument_policy: str
    available_during_turn: bool


@dataclass(frozen=True)
class ResolvedSlashCommand:
    command_id: SlashCommandId
    canonical_name: str
    args: str
    owner: SlashCommandOwner
    client_action: str | None
    presentation: SlashCommandPresentation


class SlashCommandError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
```

Use immutable `SlashCommandSpec` and `SlashAlias` records internally. Declare all 33 visible commands in the exact `VISIBLE_TUI_NAMES` order. Use `SlashArgumentPolicy.NONE` for commands that reject args and `OPTIONAL` for `/model`, `/mode`, `/permissions`, `/sandbox`, `/resume`, `/fork`, `/tools`, `/memory`, `/agents`, `/tasks`, `/trace`, and `/view`.

Declare TUI actions exactly as follows:

| Command | TUI bare action | TUI inline action |
|---|---|---|
| `/help` | `open_command_palette` | none |
| `/model` | `open_model_selector` | backend |
| `/settings` | `open_settings` | none |
| `/resume` | `open_session_selector` | backend |
| `/new` | `start_new_session` | none |
| `/resources` | `open_resources` | none |
| `/tasks` | `open_tasks` | backend |
| `/details` | `toggle_details` | none |
| `/view` | `set_view_mode` | `set_view_mode` |
| `/hotkeys` | `open_hotkeys` | none |
| `/copy` | `copy_last_response` | none |
| `/clear` | `clear_transcript` | none |
| `/login` | `open_login` | none |
| `/trust` | `open_trust` | none |
| `/quit` | `quit` | none |

All other visible commands use backend ownership. CLI uses backend ownership for `/help`, `/model`, `/resume`, `/tasks`, `/view`, and `/quit`; TUI-only commands are absent from the CLI manifest and resolve to an unavailable error on that surface. `command_manifest()` must also filter `platforms` and `feature` before projecting rows.

- [ ] **Step 4: Implement aliases, longest-prefix resolution, manifest, help, and validation**

Use a single candidate list and sort matching candidates by `(prefix length, canonical priority)` descending:

```python
def _matches_prefix(text: str, prefix: str) -> bool:
    return text == prefix or text.startswith(f"{prefix} ")


def resolve_slash_command(text: str, context: SlashCommandContext) -> ResolvedSlashCommand:
    normalized = text.strip()
    if not normalized.startswith("/"):
        raise SlashCommandError("not_slash_command", "command must start with '/'.")

    candidates = [candidate for candidate in _resolution_candidates() if _matches_prefix(normalized, candidate.prefix)]
    if not candidates:
        name = normalized.split(maxsplit=1)[0]
        raise SlashCommandError("unknown_command", f"Unknown command: {name}")
    candidate = max(candidates, key=lambda item: (len(item.prefix), item.canonical))
    spec = _SPEC_BY_ID[candidate.command_id]
    args = normalized[len(candidate.prefix):].strip()
    if candidate.args_prefix:
        args = " ".join(part for part in (candidate.args_prefix, args) if part)
    if context.surface not in spec.surfaces:
        raise SlashCommandError("unavailable_surface", f"{spec.name} is unavailable on this interface.")
    if spec.platforms is not None and context.platform not in spec.platforms:
        raise SlashCommandError("unavailable_platform", f"{spec.name} is unavailable on this platform.")
    if spec.feature is not None and spec.feature not in context.enabled_features:
        raise SlashCommandError("unavailable_feature", f"{spec.name} is unavailable because {spec.feature} is disabled.")
    policy = spec.dispatch_by_surface.get(context.surface)
    if policy is None:
        raise SlashCommandError("unavailable_surface", f"{spec.name} is unavailable on this interface.")
    if args and spec.argument_policy is SlashArgumentPolicy.NONE:
        raise SlashCommandError("invalid_arguments", _usage(spec))
    if not args and spec.argument_policy is SlashArgumentPolicy.REQUIRED:
        raise SlashCommandError("invalid_arguments", _usage(spec))
    owner = policy.inline_owner if args else policy.bare_owner
    action = policy.inline_client_action if args else policy.bare_client_action
    if owner is None:
        raise SlashCommandError("invalid_arguments", _usage(spec))
    if context.turn_running and not spec.available_during_turn:
        raise SlashCommandError("unavailable_during_turn", f"{spec.name} is disabled while a task is in progress.")
    return ResolvedSlashCommand(spec.id, spec.name, args, owner, action, spec.presentation)
```

The alias table must include every mapping in the design spec, including argument prefixes for `/subagents <child-session-id> -> /tasks agents <child-session-id>`. Keep `/session search <query>` and `/session maintenance [apply-flag]` as hidden IDs so they preserve their old handlers without entering manifests.

- [ ] **Step 5: Run the registry tests**

Run: `uv run pytest tests/unit/cli/test_slash_command_registry.py -q`

Expected: PASS.

- [ ] **Step 6: Commit the registry**

```bash
git add src/mycli/cli/slash_command_registry.py tests/unit/cli/test_slash_command_registry.py
git commit -m "feat: add typed slash command registry"
```

### Task 2: Move Backend Execution Behind Typed Command IDs

**Files:**
- Create: `src/mycli/cli/slash_command_dispatch.py`
- Modify: `src/mycli/cli/repl.py:1-268`
- Create: `tests/unit/cli/test_slash_command_dispatch.py`
- Modify: `tests/integration/test_cli_repl.py:1-60`

- [ ] **Step 1: Write failing dispatcher and CLI tests**

```python
from types import SimpleNamespace

from mycli.cli.slash_command_dispatch import dispatch_backend_slash_command
from mycli.cli.slash_command_registry import SlashCommandContext, SlashCommandSurface, resolve_slash_command


def resolve_cli(text: str):
    return resolve_slash_command(text, SlashCommandContext(surface=SlashCommandSurface.CLI))


def fake_service() -> SimpleNamespace:
    return SimpleNamespace(
        inspect_usage=lambda: ("session=demo",),
        inspect_bashes=lambda: ("shell-1 running",),
        active_background_shells=lambda: (),
        undo_last_file_change=lambda: "restored",
    )


def test_short_canonical_commands_and_hidden_aliases_share_handlers() -> None:
    service = fake_service()
    usage = dispatch_backend_slash_command(service, resolve_cli("/usage"))
    legacy_usage = dispatch_backend_slash_command(service, resolve_cli("/status usage"))
    assert usage.lines == legacy_usage.lines == ("[usage] session=demo",)


def test_ps_and_undo_are_canonical_backend_commands() -> None:
    service = fake_service()
    assert dispatch_backend_slash_command(service, resolve_cli("/ps")).command_kind == "background_shells"
    assert dispatch_backend_slash_command(service, resolve_cli("/undo")).lines == ("[undo] restored",)


def test_cli_help_is_generated_from_visible_cli_manifest() -> None:
    output = handle_slash_command("/help")
    assert "/usage" in output
    assert "/status usage" not in output
    assert "/settings" not in output
```

- [ ] **Step 2: Run tests and verify the old string dispatcher fails expectations**

Run: `uv run pytest tests/unit/cli/test_slash_command_dispatch.py tests/integration/test_cli_repl.py -q`

Expected: FAIL because typed dispatch does not exist and old help still lists nested commands.

- [ ] **Step 3: Add a structured backend result and typed dispatcher**

```python
@dataclass(frozen=True)
class SlashCommandResult:
    lines: tuple[str, ...] = ()
    presentation: SlashCommandPresentation = SlashCommandPresentation.TRANSCRIPT
    mutated_session: bool = False
    mutated_model: bool = False
    mutated_mode: bool = False
    exit_requested: bool = False
    command_kind: str | None = None
    presentation_hint: str | None = None
    processes: tuple[dict[str, object], ...] = ()
    view_mode: str | None = None
    collaboration_mode: str | None = None

    def to_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "execution": "backend",
            "lines": list(self.lines),
            "presentation": self.presentation.value,
            "mutated_session": self.mutated_session,
            "mutated_model": self.mutated_model,
            "mutated_mode": self.mutated_mode,
            "exit_requested": self.exit_requested,
        }
        for key in ("command_kind", "presentation_hint", "view_mode", "collaboration_mode"):
            value = getattr(self, key)
            if value is not None:
                payload[key] = value
        if self.processes:
            payload["processes"] = list(self.processes)
        return payload
```

Move each existing `build_command_handler()` branch under its canonical `SlashCommandId`. Preserve the exact service calls and line prefixes. Use this dispatch matrix:

| IDs | Existing behavior source |
|---|---|
| `SKILLS`, `TOOLS`, `PERMISSIONS` | `/skills`, `/tools [subcommand]`, `/permissions [subcommand]` branches |
| `PLAN`, `MODE`, `SANDBOX`, `MODEL`, `VIEW` | configuration branches |
| `AGENTS`, `TASKS`, `PS`, `STOP` | agent, bash, cancel, and process branches |
| `RESUME`, `FORK`, `SESSION_SEARCH`, `SESSION_MAINTENANCE` | session branches |
| `STATUS`, `USAGE`, `CONTEXT`, `STATS` | status branches |
| `MEMORY`, `CHANGES`, `UNDO`, `TRACE` | memory/change/trace branches |
| `HELP`, `QUIT` | generated help and exit result |

Keep argument parsing in focused helpers such as `_dispatch_tools()`, `_dispatch_tasks()`, `_dispatch_session_maintenance()`, `_parse_model_args()`, and `_parse_fork_args()`. Do not reconstruct old command strings before dispatch.

- [ ] **Step 4: Reduce `repl.py` to resolver + dispatcher control flow**

```python
def handle_slash_command(command: str) -> str:
    context = SlashCommandContext(surface=SlashCommandSurface.CLI)
    try:
        invocation = resolve_slash_command(command, context)
    except SlashCommandError as exc:
        return str(exc)
    if invocation.command_id is SlashCommandId.HELP:
        return slash_command_help(context)
    if invocation.command_id is SlashCommandId.QUIT:
        return "quit"
    return f"Unknown command: {command.strip()}"


def build_command_handler(service: TurnService) -> Callable[[str], Iterable[str]]:
    def handle(command: str) -> Iterable[str]:
        context = SlashCommandContext(surface=SlashCommandSurface.CLI)
        try:
            invocation = resolve_slash_command(command, context)
            return dispatch_backend_slash_command(service, invocation).lines
        except SlashCommandError as exc:
            return (str(exc),)
    return handle
```

Remove `canonical_slash_command()`. Update imports and tests to assert command IDs rather than normalized strings.

- [ ] **Step 5: Run dispatcher and CLI tests**

Run: `uv run pytest tests/unit/cli/test_slash_command_dispatch.py tests/integration/test_cli_repl.py tests/unit/cli/test_main.py -q`

Expected: PASS.

- [ ] **Step 6: Commit typed backend dispatch**

```bash
git add src/mycli/cli/slash_command_dispatch.py src/mycli/cli/repl.py tests/unit/cli/test_slash_command_dispatch.py tests/integration/test_cli_repl.py tests/unit/cli/test_main.py
git commit -m "refactor: dispatch slash commands by typed identity"
```

### Task 3: Expose The Registry Through Gateway

**Files:**
- Modify: `src/mycli/domain/runtime/gateway_contract.py:6-37`
- Modify: `src/mycli/cli/node_tui/gateway.py:28-70,297-335,1130-1190,1505-1513,2312-2328`
- Modify: `tests/unit/domain/runtime/test_gateway_contract.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py:637-770,1240-1270`

- [ ] **Step 1: Write failing Gateway contract tests**

```python
def test_gateway_command_list_returns_only_canonical_tui_commands(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))
    response = gateway.handle_request(RpcRequest(id="list", method="command.list", params={}))
    assert response.result is not None
    names = [item["name"] for item in response.result["commands"]]
    assert names[:3] == ["/model", "/plan", "/mode"]
    assert "/usage" in names
    assert "/status usage" not in names
    assert "/theme" not in names


def test_gateway_command_run_returns_tui_action_for_bare_hybrid_command(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))
    response = gateway.handle_request(RpcRequest(id="model", method="command.run", params={"command": "/model"}))
    assert response.result == {
        "execution": "tui",
        "client_action": "open_model_selector",
        "args": "",
        "command_id": "model",
    }


def test_gateway_command_run_executes_inline_hybrid_command(tmp_path: Path) -> None:
    gateway = NodeTuiGateway(service=FakeService(tmp_path))
    response = gateway.handle_request(RpcRequest(id="model", method="command.run", params={"command": "/model gpt-test"}))
    assert response.result is not None
    assert response.result["execution"] == "backend"
    assert response.result["mutated_model"] is True
```

- [ ] **Step 2: Run focused Gateway tests and verify they fail**

Run: `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/cli/node_tui/test_gateway.py -q`

Expected: FAIL because `command.list` is not registered and bare `/model` is not a client action.

- [ ] **Step 3: Register `command.list` and implement manifest projection**

Add `"command.list"` to `SUPPORTED_GATEWAY_RPC_METHODS`, route it in `handle_request()`, and return `command_manifest()` serialized with `dataclasses.asdict()`.

```python
def _command_context(self, params: dict[str, object]) -> SlashCommandContext:
    raw_surface = str(params.get("surface", "tui"))
    try:
        surface = SlashCommandSurface(raw_surface)
    except ValueError as exc:
        raise ValueError("surface must be 'tui' or 'cli'.") from exc
    return SlashCommandContext(
        surface=surface,
        turn_running=self._turn_running,
    )


def _handle_command_list(self, params: dict[str, object]) -> dict[str, object]:
    context = replace(self._command_context(params), turn_running=False)
    return {"commands": [asdict(item) for item in command_manifest(context)]}
```

- [ ] **Step 4: Replace Gateway string dispatch with typed resolution**

```python
def _handle_command_run(self, params: dict[str, object]) -> dict[str, object]:
    command = _required_str(params, "command").strip()
    invocation = resolve_slash_command(command, self._command_context(params))
    if invocation.owner is SlashCommandOwner.TUI:
        return {
            "execution": "tui",
            "client_action": invocation.client_action,
            "args": invocation.args,
            "command_id": invocation.command_id.value,
        }
    result = dispatch_backend_slash_command(cast(TurnService, self.service), invocation)
    payload = result.to_payload()
    if result.mutated_session and self._emit is not None:
        self._emit("session.changed", {"session_id": self.service._config.session_id})
    if result.mutated_model or result.mutated_mode:
        self._emit_event("status.changed", self._status_payload())
    return payload
```

Delete `COMMAND_OVERLAYS` and `_slash_description()`. Implement `completion.slash` by passing its params to `_handle_command_list()`, filtering the returned commands, and projecting `{"value": name, "description": description}`. Add Gateway tests for `surface="cli"` and invalid surface values.

- [ ] **Step 5: Run Gateway and protocol tests**

Run: `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q`

Expected: PASS.

- [ ] **Step 6: Commit the Gateway manifest**

```bash
git add src/mycli/domain/runtime/gateway_contract.py src/mycli/cli/node_tui/gateway.py tests/unit/domain/runtime/test_gateway_contract.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py
git commit -m "feat: expose slash command manifest through gateway"
```

### Task 4: Add TypeScript Manifest Parsing And Bootstrap Loading

**Files:**
- Create: `tui/mycli-shell/src/adapters/slash-commands.ts`
- Create: `tui/mycli-shell/test/slash-commands.test.ts`
- Modify: `tui/mycli-shell/src/model.ts:320-325`
- Modify: `tui/mycli-shell/src/index.ts:1-20`
- Modify: `tui/mycli-shell/src/gateway.ts:1-60,130-145,590-654`

- [ ] **Step 1: Write failing payload parser tests**

```typescript
test("command manifest parser preserves gateway order and rejects malformed rows", () => {
  const commands = slashCommandsFromResult({ commands: [
    { id: "model", name: "/model", description: "Choose model", argument_hint: "[model]", argument_policy: "optional", available_during_turn: true },
    { id: "usage", name: "/usage", description: "Show usage", argument_hint: null, argument_policy: "none", available_during_turn: true },
    { id: "broken", name: "broken", description: "Missing slash" },
  ] });
  assert.deepEqual(commands.map((item) => item.name), ["/model", "/usage"]);
});


test("client action parser requires a known-shaped action response", () => {
  assert.deepEqual(clientActionFromResult({ execution: "tui", client_action: "open_settings", args: "", command_id: "settings" }), {
    action: "open_settings",
    args: "",
    commandId: "settings",
  });
  assert.equal(clientActionFromResult({ execution: "backend" }), null);
});
```

- [ ] **Step 2: Run the TypeScript test and verify it fails**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="command manifest|client action"`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Add command types and strict boundary parsers**

```typescript
export type MycliShellCommand = {
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
  argumentPolicy: "none" | "optional" | "required";
  availableDuringTurn: boolean;
};

export type MycliShellClientAction = {
  action: string;
  args: string;
  commandId: string;
};
```

`slashCommandsFromResult()` must preserve array order, require IDs, require names beginning with `/`, and discard malformed records. `clientActionFromResult()` returns `null` unless `execution === "tui"` and all required string fields exist.

- [ ] **Step 4: Load the manifest during Gateway bootstrap**

Add module-level `commandSurface` and `slashCommands` values:

```typescript
const commandSurface = process.env.MYCLI_TUI_NATIVE === "1" ? "cli" : "tui";
let slashCommands: MycliShellCommand[] = [];
```

In `bootstrap()`, call `command.list` with `{ surface: commandSurface }` after `session.bootstrap` and before creating either runtime. Pass the resulting list through `commands` in `MycliShellRuntimeOptions`. Remove the three manually injected `/status`, `/usage`, and `/context` entries from `main()`.

Native mode does not have a command palette, so it does not need the manifest in its options; it still submits slash input through `command.run`.

- [ ] **Step 5: Run parser tests and typecheck**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="command manifest|client action" && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit manifest loading**

```bash
git add tui/mycli-shell/src/adapters/slash-commands.ts tui/mycli-shell/test/slash-commands.test.ts tui/mycli-shell/src/model.ts tui/mycli-shell/src/index.ts tui/mycli-shell/src/gateway.ts
git commit -m "feat: load slash command manifest in tui"
```

### Task 5: Route The TUI Palette And Local Actions Through Gateway

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts:60-130,526-550,1108-1210,1352-1507`
- Modify: `tui/mycli-shell/src/gateway.ts:517-523,610-654`
- Modify: `tui/mycli-shell/test/shell-app.test.ts:1990-2075,2240-2270,2960-3060`

- [ ] **Step 1: Write failing TUI behavior tests**

Add tests that construct a runtime with a two-item manifest and a recording `onCommandSubmit`:

```typescript
test("palette and autocomplete use only gateway command metadata", async () => {
  const commands = [
    { id: "usage", name: "/usage", description: "Show usage", argumentPolicy: "none", availableDuringTurn: true },
    { id: "ps", name: "/ps", description: "Show terminals", argumentPolicy: "none", availableDuringTurn: true },
  ];
  const runtime = new MycliShellRuntime({ initialState: sampleState(), terminal: new TestTerminal(), commands });
  runtime.showCommandPalette();
  const output = stripAnsi(runtime.ui.render(100).join("\n"));
  assert.match(output, /\/usage/);
  assert.match(output, /\/ps/);
  assert.doesNotMatch(output, /\/status usage/);
});


test("every submitted slash command goes through command.run callback", async () => {
  const submitted: string[] = [];
  const runtime = new MycliShellRuntime({
    initialState: sampleState(),
    terminal: new TestTerminal(),
    commands: [],
    onCommandSubmit: async (command) => { submitted.push(command); },
  });
  await runtime.editor.onSubmit?.("/settings");
  await runtime.editor.onSubmit?.("/status usage");
  assert.deepEqual(submitted, ["/settings", "/status usage"]);
});
```

Add one test per client-action family: selector (`open_settings`), state mutation (`toggle_details`, `clear_transcript`), async action (`open_resources`), and lifecycle (`quit`).

- [ ] **Step 2: Run focused TUI tests and verify they fail**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="gateway command metadata|command.run callback|client action"`

Expected: FAIL because `BACKEND_COMMANDS` and local command-name branches still control behavior.

- [ ] **Step 3: Remove static command metadata and centralize submission**

Delete `BACKEND_COMMANDS`, `localCommandIds()`, and `isBackendCommand()`. Change `commands()` to derive runnable entries only from `this.options.commands`:

```typescript
private commands(): RunnableCommand[] {
  return (this.options.commands ?? []).map((command) => ({
    ...command,
    run: () => this.submitCommand(command.name),
  }));
}
```

Keep input `/` as the only local parser exception because it is a palette trigger, not a registered command. For every other input beginning with `/`, add it to history, clear the editor, and call `submitCommand(input)`. Unknown commands must never fall through to `onSubmit`.

- [ ] **Step 4: Implement the stable TUI client-action map**

Expose one public method on `MycliShellRuntime`:

```typescript
async handleClientAction(action: string, args: string): Promise<void> {
  const handlers: Record<string, () => void | Promise<void>> = {
    open_command_palette: () => this.showCommandPalette(),
    open_model_selector: () => this.showModelSelector(args || undefined),
    open_settings: () => this.showSettingsSelector(),
    open_session_selector: () => this.showSessionSelector(),
    start_new_session: () => this.startNewLocalSession(),
    open_resources: () => this.showResourceSelector(),
    open_tasks: () => this.showBackgroundSubagents(),
    toggle_details: () => this.toggleToolDetails(),
    set_view_mode: () => this.setViewMode(args),
    open_hotkeys: () => this.showHotkeys(),
    copy_last_response: () => this.copyLastAssistantMessage(),
    clear_transcript: () => this.clearTranscript(),
    open_login: () => this.showLoginFlow(),
    open_trust: () => this.showTrustGate(),
    quit: () => this.shutdown(),
  };
  const handler = handlers[action];
  if (!handler) {
    this.addSystemNotice(`Internal command configuration error: unknown action ${action}`);
    return;
  }
  await handler();
}
```

Extract the existing inline clear-state expression into `clearTranscript()` so action handling is testable.

- [ ] **Step 5: Route Gateway client-action results without transcript output**

```typescript
async function runCommand(command: string): Promise<void> {
  const result = await send("command.run", { command, surface: commandSurface });
  const clientAction = clientActionFromResult(result);
  if (clientAction) {
    if (runtime) {
      await runtime.handleClientAction(clientAction.action, clientAction.args);
    }
    return;
  }
  setRuntimeState(runtimeStateWithCommandResult(runtimeState, command, result));
  if (result.exit_requested === true) await shutdown(0);
}
```

Do not append a `command_output` block for `execution=tui`.

- [ ] **Step 6: Run TUI tests and typecheck**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="command|palette|autocomplete|settings|model|session|tasks" && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit unified TUI command handling**

```bash
git add tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/src/gateway.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "refactor: drive tui commands from gateway registry"
```

### Task 6: Remove Legacy Catalogs And Update Secondary Clients

**Files:**
- Delete: `src/mycli/cli/slash_commands.py`
- Modify: `tui/mycli-shell/src/native-chat-runtime.ts:120-155`
- Modify: `tui/mycli-shell/test/native-chat-runtime.test.ts`
- Modify: `tui/mycli-shell/test/support/scripted-client.ts:30-150`
- Modify: `tests/integration/test_node_tui_gateway.py`

- [ ] **Step 1: Add regression tests proving secondary clients use Gateway dispatch**

Add a native runtime test asserting `/help` is passed to `onCommandSubmit` and is not locally expanded. Add an integration scripted-client assertion that `/usage` calls `command.run` with `surface="cli"`. Remove expectations for the unsupported local `/theme mono` behavior.

```typescript
test("native runtime delegates slash commands without local aliases", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const commands: string[] = [];
  const runtime = new NativeChatRuntime({
    initialState: stateWithMessages(0),
    streams: { input, output },
    columns: () => 100,
    onCommandSubmit: async (command) => { commands.push(command); },
  });
  runtime.start();
  input.write("/help\n");
  input.write("/status usage\n");
  await setTimeout(10);
  assert.deepEqual(commands, ["/help", "/status usage"]);
  await runtime.stop({ notifyExit: false });
});
```

- [ ] **Step 2: Run secondary-client tests and verify outdated expectations fail**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="native runtime delegates|scripted"`

Expected: FAIL until local special cases are removed.

- [ ] **Step 3: Delete old command sources and local scripted behavior**

Delete `slash_commands.py` after confirming `rg "slash_command_candidates"` has no consumers. Remove `LOCAL_HELP_LINES`, `/theme mono`, `/sessions`, and `/session` special branches from `scripted-client.ts`; all slash inputs use `command.run` and `runtimeStateWithCommandResult()` unless the response is a TUI action unavailable to that client.

Keep native `/quit` routed through `command.run` with `surface="cli"`; the backend result's `exit_requested` drives shutdown. This makes native behavior match CLI/Gateway identity instead of maintaining a fourth alias table.

- [ ] **Step 4: Run Python and TypeScript secondary-client suites**

Run: `uv run pytest tests/integration/test_node_tui_gateway.py -q`

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern="native|scripted|gateway" && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Confirm no divergent command metadata remains**

Run:

```bash
rg -n "BACKEND_COMMANDS|_SLASH_COMMANDS|_slash_description|canonical_slash_command|LOCAL_HELP_LINES" src tests tui/mycli-shell
```

Expected: no matches.

- [ ] **Step 6: Commit cleanup**

```bash
git add -A src/mycli/cli/slash_commands.py tui/mycli-shell/src/native-chat-runtime.ts tui/mycli-shell/test/native-chat-runtime.test.ts tui/mycli-shell/test/support/scripted-client.ts tests/integration/test_node_tui_gateway.py
git commit -m "refactor: remove duplicate slash command catalogs"
```

### Task 7: Cross-Layer Verification And Final Consistency Tests

**Files:**
- No planned file changes. If a verification failure exposes a slash-command regression, modify only the file that owns that failed behavior and its focused test.

- [ ] **Step 1: Run focused Python tests**

Run:

```bash
uv run pytest \
  tests/unit/cli/test_slash_command_registry.py \
  tests/unit/cli/test_slash_command_dispatch.py \
  tests/integration/test_cli_repl.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tests/integration/test_node_tui_gateway.py \
  tests/unit/domain/runtime/test_gateway_contract.py -q
```

Expected: PASS.

- [ ] **Step 2: Run the complete Python quality suite**

Run:

```bash
uv run pytest -q
uv run ruff check src tests
uv run mypy src
```

Expected: all tests pass, Ruff reports no errors, and mypy reports success for all source files.

- [ ] **Step 3: Run the complete TypeScript suite**

Run:

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all Node tests and TypeScript typechecking pass.

- [ ] **Step 4: Perform the command-surface audit**

Run:

```bash
uv run python -c 'from mycli.cli.slash_command_registry import SlashCommandContext, SlashCommandSurface, command_manifest; tui=command_manifest(SlashCommandContext(surface=SlashCommandSurface.TUI)); cli=command_manifest(SlashCommandContext(surface=SlashCommandSurface.CLI)); names=tuple(item.name for item in tui); assert len(names)==33; assert all(name in names for name in ("/usage", "/context", "/ps", "/undo")); assert all(name not in names for name in ("/status usage", "/tasks bashes", "/theme", "/mark", "/release-notes")); assert "/settings" not in tuple(item.name for item in cli); print("slash command surface OK")'
rg -n "open_command_palette|open_model_selector|open_settings|open_session_selector|start_new_session|open_resources|open_tasks|toggle_details|set_view_mode|open_hotkeys|copy_last_response|clear_transcript|open_login|open_trust|quit" tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/test/shell-app.test.ts
```

Verify:

- exactly 33 TUI commands are returned in spec order;
- `/usage`, `/context`, `/ps`, and `/undo` are present;
- no alias is present;
- `/theme`, `/mark`, and `/release-notes` are absent;
- CLI manifest excludes TUI-only commands;
- every TUI action in the registry has a TypeScript handler test.

- [ ] **Step 5: Commit any verification-only fixes**

If verification required changes, stage only those slash-command files and commit:

```bash
git commit -m "test: verify unified slash command registry"
```

If no files changed, do not create an empty commit.
