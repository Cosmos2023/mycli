# Check Results

## Passed

- `uv run pytest tests/unit/services/test_safety_policy.py::test_safety_policy_requires_choice_for_medium_risk_write_when_strict tests/unit/services/test_safety_policy.py::test_safety_policy_requires_choice_for_medium_risk_edit_when_strict tests/unit/services/test_safety_policy.py::test_safety_policy_requires_choice_for_medium_risk_kill_shell_when_strict tests/unit/services/test_approval_service.py::test_approval_service_suspends_medium_risk_write_when_strict tests/unit/application/test_agent_runtime.py::test_agent_runtime_requires_approval_for_medium_risk_write_when_strict -q`
  - `5 passed`
- `uv run pytest tests/unit/services/test_safety_policy.py tests/unit/services/test_approval_service.py tests/unit/application/test_agent_runtime.py::test_agent_runtime_requires_approval_for_medium_risk_write_when_strict tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_with_real_runtime_strict_write_approval -q`
  - `22 passed`
- `uv run ruff check src/mycli/services/approval/safety_policy.py src/mycli/application/runtime/agent_runtime.py tests/unit/services/test_safety_policy.py tests/unit/services/test_approval_service.py tests/unit/application/test_agent_runtime.py tests/integration/test_node_tui_gateway.py`
  - `All checks passed!`
- `uv run mypy src/mycli/services/approval/safety_policy.py src/mycli/application/runtime/agent_runtime.py tests/unit/services/test_safety_policy.py tests/unit/services/test_approval_service.py`
  - `Success: no issues found in 4 source files`
- `uv run pytest tests/unit/application/test_agent_runtime.py tests/integration/test_node_tui_gateway.py -q`
  - `97 passed`
- `uv run pytest tests/unit/services/test_safety_policy.py tests/unit/services/test_approval_service.py tests/unit/services/test_doctor_service.py tests/integration/test_turn_service.py tests/integration/test_node_tui_gateway.py -q`
  - `114 passed`
- `uv run pytest -q`
  - `1183 passed`
- `npm --prefix tui/node test -- --runInBand`
  - `135 passed`

## Notes

- Default `auto_approve_medium=True` behavior remains compatible.
- Strict medium-risk mode now pauses `Write`, `Edit`, and `KillShell` for
  approval, while workspace-boundary violations still deny directly.
- Node scripted smoke uses a real `AgentRuntime` and `WriteTool` to verify
  waiting approval, approve-once resolution, and file write completion.
