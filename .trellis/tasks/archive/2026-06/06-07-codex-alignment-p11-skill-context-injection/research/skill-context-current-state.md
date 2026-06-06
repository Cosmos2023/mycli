# Skill Context Current State

## Read Sources

- `docs/parity/codex-alignment-phases-p9-p13.md`
- `src/mycli/tools/skill.py`
- `src/mycli/services/context/skill_catalog.py`
- `src/mycli/services/skills/provider.py`
- `src/mycli/application/runtime/agent_runtime.py`
- `src/mycli/application/runtime/tools/tool_execution_service.py`
- `src/mycli/cli/bootstrap.py`
- `tests/unit/application/test_agent_runtime.py`
- `tests/unit/application/test_tool_execution_service.py`
- `tests/unit/application/test_skill_tool_lifecycle.py`
- `tests/unit/cli/test_main.py`

## Current Flow

Default runtime already registers one stable built-in `Skill` tool:

```text
AgentRuntime -> ToolRegistry.register(SkillTool(skill_registry))
```

Runtime context already renders a skill catalog:

```text
Available skills:
- code-review: Review code

Use the Skill tool with the exact skill name ...
```

Successful `Skill` tool calls append a model-visible user message wrapped in
`<skill_instructions>...</skill_instructions>`, add a `SKILL_INSTRUCTIONS` turn
item, and persist an `InvokedSkillSnapshot`.

The legacy compatibility path is separate:

```text
SkillToolContributionProvider -> skill_code_review / skill_xxx contributed tools
```

`bootstrap.py` currently does not include `SkillToolContributionProvider` in
the default contributed providers; only MCP providers are added by default.

## P11 Design Implication

The smallest useful P11 is mostly hardening and diagnostics:

- keep `SkillToolContributionProvider` explicit-only;
- add regression tests that default runtime/provider exposure is stable as skill count changes;
- add bounded skill activation trace rows so activation is discoverable without raw skill body;
- document the stable catalog + explicit activation contract.

## Redaction Boundary

Allowed diagnostics:

- skill name;
- source kind;
- source path presence or basename only when already non-secret;
- content digest;
- content length;
- trace turn id;
- replayability flags.

Forbidden diagnostics:

- raw skill body;
- raw user prompt;
- raw tool output;
- secrets from frontmatter/body;
- full local private paths when not already part of existing transcript metadata.

## Compact Boundary

P11 can test existing invoked-skill snapshot behavior, including missing source
fallback to cached excerpt, but must not edit compact/rehydration code.
