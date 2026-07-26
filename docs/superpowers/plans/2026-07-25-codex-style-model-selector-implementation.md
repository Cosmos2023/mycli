# Codex-Style Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's static `/model` picker with a backend-owned, two-stage model and reasoning selector that atomically switches providers and persists the chosen default.

**Architecture:** A typed model catalog owns provider/model capabilities. `TurnService` validates and applies a complete selection through a model-adapter factory, while a small config writer persists only model-related settings with rollback. The Gateway exposes `model.list` and `model.select`; the TUI renders the returned capabilities and updates local state only after backend success.

**Tech Stack:** Python 3.13, dataclasses, pytest, JSON-RPC Gateway, TypeScript, `@mariozechner/pi-tui`, Node test runner.

---

### Task 1: Model Catalog

**Files:**
- Create: `src/mycli/domain/model_catalog.py`
- Create: `src/mycli/services/model_catalog.py`
- Modify: `src/mycli/config/auth_store.py`
- Test: `tests/unit/services/test_model_catalog.py`
- Test: `tests/unit/config/test_auth_store.py`

- [ ] **Step 1: Write failing catalog and configured-provider tests**

Cover configured-provider enumeration, built-in presets, current custom-model injection, current-first ordering, and model-specific reasoning efforts.

```python
def test_catalog_filters_unconfigured_providers_and_injects_current_model(tmp_path: Path) -> None:
    AuthStore.from_home(tmp_path).set_api_key("openai", "sk-openai")
    entries = ModelCatalogService(home_dir=tmp_path).list_models(current_config=config)
    assert entries[0].model == config.model
    assert {entry.provider for entry in entries} == {ProviderId.OPENAI, config.provider}

def test_catalog_exposes_only_supported_reasoning_efforts() -> None:
    entry = next(item for item in BUILTIN_MODEL_CATALOG if item.model == "gpt-5.4")
    assert entry.supported_reasoning_efforts == (
        ReasoningEffort.LOW,
        ReasoningEffort.MEDIUM,
        ReasoningEffort.HIGH,
        ReasoningEffort.XHIGH,
    )
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `uv run pytest tests/unit/services/test_model_catalog.py tests/unit/config/test_auth_store.py -q`

Expected: FAIL because the catalog and `configured_providers()` do not exist.

- [ ] **Step 3: Implement the typed catalog**

Define immutable `ModelCatalogEntry` and `ModelSelection` values containing provider, protocol, model, display name, description, base URL, supported/default efforts, and current/default flags. Add curated built-in entries and always inject the active custom model. Add `AuthStore.configured_providers()` without exposing credential values.

```python
@dataclass(frozen=True, slots=True)
class ModelCatalogEntry:
    provider: ProviderId
    protocol: ProtocolId
    model: str
    display_name: str
    description: str
    base_url: str
    supported_reasoning_efforts: tuple[ReasoningEffort, ...] = ()
    default_reasoning_effort: ReasoningEffort | None = None
    is_default: bool = False
    is_current: bool = False
```

- [ ] **Step 4: Run focused tests**

Run: `uv run pytest tests/unit/services/test_model_catalog.py tests/unit/config/test_auth_store.py -q`

Expected: PASS.

### Task 2: Persistent Atomic Model Selection

**Files:**
- Create: `src/mycli/config/model_settings.py`
- Create: `src/mycli/llms/model_adapter_factory.py`
- Modify: `src/mycli/application/runtime/model/model_state.py`
- Modify: `src/mycli/application/runtime/model/model_turn_requester.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/bootstrap.py`
- Test: `tests/unit/config/test_model_settings.py`
- Test: `tests/unit/application/test_agent_runtime.py`
- Test: `tests/unit/application/test_turn_service_model_selection.py`

- [ ] **Step 1: Write failing persistence, adapter replacement, and rollback tests**

```python
def test_save_model_settings_preserves_unrelated_config(tmp_path: Path) -> None:
    path = default_user_config_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text('[tui]\ntheme = "light"\n', encoding="utf-8")
    save_model_settings(tmp_path, selection)
    assert load_shell_settings(tmp_path).theme == "light"

def test_select_model_rolls_back_when_runtime_rebind_fails(service, monkeypatch) -> None:
    before = service._config
    monkeypatch.setattr(service._runtime, "replace_model_adapter", Mock(side_effect=RuntimeError("boom")))
    with pytest.raises(ModelSelectionError):
        service.select_model(selection)
    assert service._config == before
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `uv run pytest tests/unit/config/test_model_settings.py tests/unit/application/test_turn_service_model_selection.py tests/unit/application/test_agent_runtime.py -q`

Expected: FAIL because model persistence and adapter replacement are absent.

- [ ] **Step 3: Extract the model adapter factory and add runtime replacement**

Move provider/protocol-specific adapter construction out of `bootstrap.py` into `build_model_adapter(config, workspace_log_service)`. Add `replace_model_adapter()` methods to the runtime, model state, and model requester so every request path sees the new adapter.

```python
def replace_model_adapter(self, model_adapter: ModelAdapter, config: AgentConfig) -> None:
    self._model_adapter = model_adapter
    self._model_turn_requester.replace_model_adapter(model_adapter)
    self._model_state.replace_model_adapter(model_adapter)
    self.rebind_session(config)
```

- [ ] **Step 4: Implement atomic save and selection**

`save_model_settings()` must preserve unrelated TOML keys and write provider, protocol, model, base URL, reasoning enabled/effort. `TurnService.select_model()` validates catalog membership and credentials, creates the adapter before mutation, saves config, swaps the runtime, and restores both file bytes and in-memory state if any later step fails.

- [ ] **Step 5: Run focused tests**

Run: `uv run pytest tests/unit/config/test_model_settings.py tests/unit/application/test_turn_service_model_selection.py tests/unit/application/test_agent_runtime.py -q`

Expected: PASS.

### Task 3: Gateway Model Contract

**Files:**
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/domain/runtime/gateway_contract.py`
- Test: `tests/unit/cli/node_tui/test_gateway.py`
- Test: `tests/unit/domain/runtime/test_gateway_contract.py`

- [ ] **Step 1: Write failing JSON-RPC contract tests**

```python
def test_gateway_lists_models_and_selects_complete_target(tmp_path: Path) -> None:
    listed = gateway.handle_request(RpcRequest(id="list", method="model.list", params={}))
    assert listed.result["models"][0]["current"] is True
    selected = gateway.handle_request(RpcRequest(
        id="select",
        method="model.select",
        params={"provider": "openai", "protocol": "responses", "model": "gpt-5.4", "reasoning_effort": "high"},
    ))
    assert selected.result["status"]["model"] == "gpt-5.4"
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q`

Expected: FAIL with `method_not_found`.

- [ ] **Step 3: Implement `model.list` and `model.select`**

Validate all fields, call the catalog/service APIs, return refreshed `status` and `models`, emit `status.changed`, and keep both methods out of transcript persistence. Include catalog data in bootstrap/status projection so reconnects restore the selector.

- [ ] **Step 4: Run focused tests**

Run: `uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q`

Expected: PASS.

### Task 4: TUI Types and Gateway Client

**Files:**
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`

- [ ] **Step 1: Write failing projection and request tests**

Assert that descriptions, protocol, base URL, supported/default reasoning efforts, and current/default markers survive status projection, and that selection sends the structured `model.select` request.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern='model catalog|model select'`

Expected: FAIL because the current model type only contains id/provider/static effort.

- [ ] **Step 3: Extend model types and Gateway API**

```ts
export type MycliShellModel = {
  id: string;
  provider: string;
  protocol: string;
  baseUrl: string;
  name?: string;
  description?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  current?: boolean;
  default?: boolean;
};
```

Add `selectModel(selection)` and project snake-case Gateway fields without inventing capabilities in TypeScript.

- [ ] **Step 4: Run focused tests**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern='model catalog|model select'`

Expected: PASS.

### Task 5: Two-Stage Selector

**Files:**
- Modify: `tui/mycli-shell/src/components/model-selector.ts`
- Test: `tui/mycli-shell/test/model-selector.test.ts`

- [ ] **Step 1: Write failing component tests**

Cover fuzzy filtering, current-first rows, model/default labels, no-effort direct apply, one-effort direct apply, multiple-effort second stage, Escape restoration, inline errors, empty state, and widths from 30 to 120 columns.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern='model selector'`

Expected: FAIL against the one-stage static selector.

- [ ] **Step 3: Implement the Codex-style state machine**

Use `stage: "model" | "reasoning"`, preserve model query/selection while in the effort stage, and derive effort rows only from the selected model. Strip descriptions first and provider labels second as width narrows; truncate every rendered line to the available width.

- [ ] **Step 4: Run focused tests**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern='model selector'`

Expected: PASS.

### Task 6: Shell Integration and Verification

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing shell integration tests**

Verify bare `/model` opens the selector without transcript output, successful selection waits for the backend before closing/updating the footer, and failure keeps the selector open with the previous footer state and an inline error.

- [ ] **Step 2: Run tests and verify they fail**

Run: `cd tui/mycli-shell && npm test -- --test-name-pattern='model selector'`

Expected: FAIL because current code applies an optimistic local update and serializes selection through `/model`.

- [ ] **Step 3: Wire structured selection**

Remove optimistic provider/model mutation. Await `gateway.selectModel()`, reduce returned status/catalog, close only on success, and call `selector.setError()` on failure.

- [ ] **Step 4: Run all verification**

Run:

```bash
uv run pytest -q
uv run ruff check src tests
uv run mypy src
cd tui/mycli-shell && npm test
cd tui/mycli-shell && npm run typecheck
```

Expected: all commands pass with no regressions.
