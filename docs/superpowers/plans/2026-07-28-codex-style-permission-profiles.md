# Codex-Style Permission Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's split sandbox and permissions controls with one Codex-style permission-profile selector while preserving legacy commands and session allowances.

**Architecture:** Add a canonical built-in permission profile that maps to sandbox and approval behavior, update the running policy through a narrow runtime API, expose it through the gateway, and render a dedicated Node TUI selector. Existing `sandbox_mode` and inline permission commands remain compatibility surfaces.

**Tech Stack:** Python 3.13, pytest, JSON-RPC gateway, TypeScript, OpenTUI-style component primitives, Node test runner.

---

## File Structure

- `src/mycli/domain/runtime/execution_policy.py`: define built-in profiles and profile-to-sandbox behavior.
- `src/mycli/domain/runtime/__init__.py`: export the permission profile type and add optional profile state to `AgentConfig`.
- `src/mycli/application/runtime/tools/runtime_policy.py`: apply profile approval semantics and support approved sandbox escalation.
- `src/mycli/application/runtime/tools/tool_execution_service.py`: pass approval state into runtime shell options.
- `src/mycli/application/runtime/agent_runtime.py`: update permission policy without rebinding the session.
- `src/mycli/application/turn_service.py`: inspect and update profiles; preserve legacy sandbox commands and allowances.
- `src/mycli/cli/slash_command_registry.py`: make bare `/permissions` TUI-owned and available during turns.
- `src/mycli/cli/node_tui/gateway.py`: add permission list/update RPC methods and status payloads.
- `tui/mycli-shell/src/model.ts`: represent permission profiles in shell state.
- `tui/mycli-shell/src/adapters/runtime-state.ts`: project gateway permission state.
- `tui/mycli-shell/src/components/permission-selector.ts`: render profile and allowance selection.
- `tui/mycli-shell/src/shell-runtime.ts`: open the selector from `/permissions` and `Ctrl+X`, confirm Full Access, and handle update errors.
- `tui/mycli-shell/src/gateway.ts`: connect selector callbacks to gateway RPC.
- Existing Python and TypeScript test files: lock down domain, gateway, compatibility, and rendering behavior.

### Task 1: Permission Profile Domain and Runtime Semantics

**Files:**
- Modify: `src/mycli/domain/runtime/execution_policy.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/application/runtime/tools/runtime_policy.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Test: `tests/unit/application/test_tool_policy_runtime.py`
- Test: `tests/unit/application/test_tool_execution_service.py`

- [ ] **Step 1: Write failing profile mapping and policy tests**

Add assertions equivalent to:

```python
assert PermissionProfile.READ_ONLY.sandbox_mode is SandboxMode.READ_ONLY
assert PermissionProfile.WORKSPACE.sandbox_mode is SandboxMode.WORKSPACE_WRITE
assert PermissionProfile.FULL_ACCESS.sandbox_mode is SandboxMode.DANGER_FULL_ACCESS

gate.set_permission_profile(PermissionProfile.FULL_ACCESS)
decision = gate.decide(risky_shell_call, effect_profile=ToolEffectProfile(process=True))
assert decision.kind is ToolRuntimeDecisionKind.ALLOWED
```

Also verify explicit execpolicy deny rules still deny in Full Access and approved shell calls receive unrestricted shell execution options.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
uv run pytest tests/unit/application/test_tool_policy_runtime.py tests/unit/application/test_tool_execution_service.py -q
```

Expected: failures because `PermissionProfile` and profile-aware shell options do not exist.

- [ ] **Step 3: Implement built-in profiles and runtime policy updates**

Introduce:

```python
class PermissionProfile(StrEnum):
    READ_ONLY = "read-only"
    WORKSPACE = "workspace"
    FULL_ACCESS = "full-access"

    @property
    def sandbox_mode(self) -> SandboxMode:
        return {
            self.READ_ONLY: SandboxMode.READ_ONLY,
            self.WORKSPACE: SandboxMode.WORKSPACE_WRITE,
            self.FULL_ACCESS: SandboxMode.DANGER_FULL_ACCESS,
        }[self]
```

Add `permission_profile: PermissionProfile | None = None` to `AgentConfig`; `None` derives from legacy `sandbox_mode`. Store the effective profile in `RuntimePolicyGate`, expose `set_permission_profile()`, and bypass routine approval evaluation only for Full Access after collaboration, sandbox, and execpolicy decisions. Make `shell_execution_options(policy_approved=True)` use an unrestricted policy so an approved network or outside-workspace shell call can actually execute.

- [ ] **Step 4: Run focused tests and verify pass**

Run the command from Step 2. Expected: all selected tests pass.

### Task 2: Narrow Runtime Update and Service Compatibility

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/cli/slash_command_dispatch.py`
- Test: `tests/unit/application/test_agent_runtime.py`
- Test: `tests/unit/cli/test_slash_command_dispatch.py`

- [ ] **Step 1: Write failing update and compatibility tests**

Cover:

```python
service.set_permission_profile("full-access")
assert service.permission_profile_payload()["id"] == "full-access"
assert runtime.config.sandbox_mode is SandboxMode.DANGER_FULL_ACCESS
assert runtime.rebind_calls == 0

service.set_sandbox_mode("read-only")
assert service.permission_profile_payload()["id"] == "read-only"
assert service.inspect_permissions()  # allowances remain present
```

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
uv run pytest tests/unit/application/test_agent_runtime.py tests/unit/cli/test_slash_command_dispatch.py -q
```

Expected: failures for missing profile APIs.

- [ ] **Step 3: Implement narrow profile updates**

Add an `AgentRuntime.update_permission_profile(config)` method that updates `_config`, `SafetyPolicy`, runtime context, and `RuntimePolicyGate` without resetting queues, provider timelines, or notification inboxes. Add service methods:

```python
def list_permission_profiles(self) -> tuple[dict[str, object], ...]: ...
def permission_profile_payload(self) -> dict[str, object]: ...
def set_permission_profile(self, profile_id: str) -> dict[str, object]: ...
```

Map legacy `/sandbox read-only|workspace-write|danger-full-access|next` through the profile API. Keep `/permissions allow|revoke|clear` unchanged.

- [ ] **Step 4: Run focused tests and verify pass**

Run the command from Step 2. Expected: all selected tests pass.

### Task 3: Gateway Permission Contract

**Files:**
- Modify: `src/mycli/cli/slash_command_registry.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Test: `tests/unit/cli/test_slash_command_registry.py`
- Test: `tests/unit/cli/node_tui/test_gateway.py`

- [ ] **Step 1: Write failing RPC and slash ownership tests**

Verify bare `/permissions` resolves to `client_action="open_permissions"`, inline permission commands remain backend-owned, and `permissions.list` / `permissions.update` work while `turn_running=True`.

Expected response shape:

```python
{
    "active": "workspace",
    "profiles": [{"id": "workspace", "label": "Ask for approval", "current": True}],
    "command_allowance_count": 0,
}
```

- [ ] **Step 2: Run gateway tests and verify failure**

Run:

```bash
uv run pytest tests/unit/cli/test_slash_command_registry.py tests/unit/cli/node_tui/test_gateway.py -q
```

Expected: failures for unknown client action and RPC methods.

- [ ] **Step 3: Implement RPC dispatch and status projection**

Add `permissions.list` and `permissions.update` handling. Validate profile IDs, return structured gateway errors, emit `status.changed` after success, and include the permission payload in bootstrap/status. Change `/permissions` to a hybrid TUI/backend policy and keep it available during a turn.

- [ ] **Step 4: Run gateway tests and verify pass**

Run the command from Step 2. Expected: all selected tests pass.

### Task 4: Codex-Style Node TUI Selector

**Files:**
- Create: `tui/mycli-shell/src/components/permission-selector.ts`
- Modify: `tui/mycli-shell/src/index.ts`
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`
- Test: `tui/mycli-shell/test/permission-selector.test.ts`
- Test: `tui/mycli-shell/test/runtime-state.test.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing component and interaction tests**

Test that the selector renders `Update Model Permissions`, current-state text, wrapped descriptions, and `Command allowances...`; arrows navigate, Escape cancels, Enter confirms, and Full Access requires a second confirmation. Assert `Ctrl+X` and `open_permissions` open the selector instead of submitting `/sandbox next`.

- [ ] **Step 2: Run Node tests and verify failure**

Run:

```bash
cd tui/mycli-shell && npm test
```

Expected: failures for the missing component and old Ctrl+X behavior.

- [ ] **Step 3: Implement the selector and gateway callbacks**

Add state types:

```typescript
export type MycliShellPermissionProfile = {
  id: "read-only" | "workspace" | "full-access";
  label: string;
  description: string;
  current: boolean;
  disabledReason?: string;
};
```

Use the existing `Container`, `Text`, `DynamicBorder`, and keybinding abstractions. Add `onPermissionSelect` to `MycliShellRuntimeOptions`; wire it to `client.send("permissions.update", { profile })`; keep the selector open and call `setError()` when the RPC fails. Add one compact system notice after acknowledgement.

- [ ] **Step 4: Run Node tests and verify pass**

Run the command from Step 2. Expected: all Node tests pass.

### Task 5: Regression Verification and Documentation Sync

**Files:**
- Modify only if required by changed behavior: `README.md`
- Verify: all files changed in Tasks 1-4

- [ ] **Step 1: Run formatting and static checks**

```bash
uv run ruff check src/mycli tests/unit
uv run mypy src/mycli
cd tui/mycli-shell && npm run typecheck
```

Expected: zero errors in touched surfaces.

- [ ] **Step 2: Run full targeted regression suites**

```bash
uv run pytest tests/unit/application tests/unit/cli -q
cd tui/mycli-shell && npm test
```

Expected: all tests pass; no existing sandbox, allowance, gateway, or shell-app regressions.

- [ ] **Step 3: Inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; unrelated pre-existing worktree changes remain untouched.

- [ ] **Step 4: Commit implementation files in scoped batches**

Commit domain/runtime, gateway, and TUI changes separately, staging explicit paths only. Do not stage pre-existing unrelated modifications.
