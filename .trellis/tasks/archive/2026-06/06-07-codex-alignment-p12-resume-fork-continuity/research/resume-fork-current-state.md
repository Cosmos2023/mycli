# Resume/Fork And Compact Boundary Current State

## Read Sources

- `docs/parity/codex-alignment-phases-p9-p13.md`
- `tests/integration/test_turn_service.py`
- `tests/unit/services/test_session_service.py`
- `tests/unit/services/context/compaction/test_rehydration.py`
- `tests/unit/services/context/compaction/test_pipeline.py`
- `tests/unit/services/test_request_shape_builder.py`
- `src/mycli/application/runtime/turn_executor.py`
- `src/mycli/application/runtime/agent_runtime.py`
- `src/mycli/state/session_service.py`
- `src/mycli/services/context/compaction/pipeline.py`

## Existing Coverage

Resume/fork:

- `test_turn_service_resumes_root_to_tip_before_resolving_pending_approval`
- `test_turn_service_resumes_root_to_tip_before_resolving_pending_clarification`
- `test_session_service_forks_conversation_at_requested_point`
- `test_session_service_resumes_ancestor_as_current_tip_lineage`
- `test_session_service_resumes_newest_child_branch_when_siblings_exist`

Compact/rehydration:

- invoked skill rehydration reads source and falls back to cached excerpt;
- provider-private reasoning messages are filtered from compaction inputs;
- request-shape tests include `compaction_rehydration` fragment behavior.

## P12 Design Implication

The implementation should be conservative:

- add missing regression assertions around parent transcript isolation and
  request-shape stable-prefix behavior;
- add bounded trace rows only if useful for explaining continuity;
- do not edit compact/rehydration implementation files.

## Redaction Boundary

Allowed diagnostics:

- requested session id;
- resolved session id;
- lineage depth/counts;
- pending state kind (`approval`, `clarification`, `none`);
- bounded turn/session ids.

Forbidden diagnostics:

- raw user prompt;
- raw tool output;
- provider request/response body;
- provider-private reasoning content;
- secrets.
