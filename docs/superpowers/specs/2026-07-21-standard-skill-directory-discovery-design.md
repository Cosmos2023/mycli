# Standard Skill Directory Discovery Design

## Goal

Allow mycli to load directory-based Agent Skills without breaking existing flat skill files.
Repository authors should be able to share a skill with other agents through
`.agents/skills/<skill-name>/SKILL.md`, while mycli-specific and user-level skills remain
available under `.mycli`.

## Supported Locations

mycli discovers skills from these sources, from lowest to highest precedence:

1. Built-in: `src/mycli/prompts/skills/`
2. User: `~/.mycli/skills/`
3. Shared repository: `<workspace>/.agents/skills/`
4. mycli repository: `<workspace>/.mycli/skills/`

Each source supports both formats:

```text
skills/<skill-name>.md
skills/<skill-name>/SKILL.md
```

The flat form remains a compatibility format. New skills should use the directory form so
they can include sibling `scripts/`, `references/`, and `assets/` directories.

## Discovery And Precedence

`SkillRegistry` receives an ordered collection of skill directories instead of a fixed set of
three roots. It scans each directory deterministically:

1. Flat `*.md` files in lexical path order.
2. Direct-child `*/SKILL.md` files in lexical path order.

Later sources override earlier sources when two definitions have the same frontmatter `name`.
Within one source, directory-form `SKILL.md` overrides a flat file with the same skill name.
All collisions remain visible through the existing duplicate diagnostics.

Discovery is limited to direct children. mycli does not recursively treat files under
`scripts/`, `references/`, or `assets/` as independent skills.

## Skill Format

Both formats retain the existing TOML frontmatter contract:

```markdown
---
name = "code-review"
description = "Review code for correctness risks"
trigger_hints = ["review"]
---

Skill instructions.
```

The skill name continues to come from frontmatter rather than the directory name. A mismatch
does not prevent loading because existing skills may already use aliases.

## Runtime Behavior

Only discovery changes. Metadata indexing, lazy body loading, provider-safe tool names,
dependency fields, diagnostics, and model-visible skill content remain unchanged. The runtime
does not copy skill assets or inject their contents automatically; instructions may reference
them relative to the skill's `source_path`.

## Compatibility

- Existing built-in, user, and repository `*.md` skills continue to load.
- Existing precedence remains `repo > user > builtin`; the new shared repository source sits
  between user and mycli-specific repository skills.
- No existing skill files are moved or rewritten.
- README documentation will identify directory-form skills as preferred and flat files as
  legacy-compatible.

## Verification

Tests will cover:

- Loading `skills/<name>/SKILL.md` and preserving its source path.
- Ignoring nested support markdown files.
- Loading `.agents/skills` through application bootstrap.
- Precedence across built-in, user, shared repository, and mycli repository sources.
- Directory-form precedence over a same-source flat definition.
- Continued loading of existing flat `*.md` skills and duplicate diagnostics.

