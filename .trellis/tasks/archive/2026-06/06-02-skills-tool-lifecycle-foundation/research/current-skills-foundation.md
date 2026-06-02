# Current Skills Foundation Research

## Existing Code

- `src/mycli/services/skills/registry.py`
  - Loads `*.md` skill files from built-in and user roots.
  - Parses TOML frontmatter split by `---`.
  - User root overrides built-in by name.
  - No diagnostics for malformed/unreadable/duplicate skills.
- `src/mycli/tools/skill.py`
  - Built-in `Skill` tool loads a skill body by name and returns body content.
  - This is a normal built-in tool, not a skill-origin contributed tool.
- `src/mycli/application/runtime/agent_runtime.py`
  - Registers `SkillTool`.
  - Records invoked skill snapshots through `ToolExecutionService`.
- `src/mycli/services/extensions/manifest.py`
  - Marks `skills` as `foundation_only`.
  - Does not expose discovered skills in the tool manifest.

## Gap For This Slice

- Add a richer discovery result and diagnostics surface without changing the
  existing `SkillTool` contract.
- Add a skill-origin contributed tool provider/adapter for manifest and runtime
  lifecycle proof.
- Keep skill body content out of doctor output and manifest metadata.
- Add deterministic smoke using temporary built-in/user/repo skill folders.

## Safety Notes

- Doctor may show skill names, source kinds, relative/bounded path labels, and
  failure kinds.
- Doctor and manifests must not print skill body content.
- Skill invocation smoke may inspect the body in tool result because the model
  needs skill instructions after explicit invocation.
