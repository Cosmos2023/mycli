# Provider / Cache Policy P1

## Goal

Make existing turn-context cache metadata affect provider-visible request shape
and diagnostics. The runtime should keep stable request prefix sections stable
across turns, identify the first changed section when stable context changes,
and expose bounded trace/doctor diagnostics without raw prompt content.

## Background

Context P1 already introduced `TurnContextSection.cache_class` values:
`static`, `dynamic`, and `ephemeral`. The current request-shape builder preserves
some metadata, but contextual fragments are still treated mostly as volatile
diagnostic fragments and the cache diagnostics do not expose a clear cache
boundary or estimated cacheable prefix. This slice turns the metadata into a
request-shape contract that later budget/eviction and subagent-fork work can
build on.

## Scope

- Order provider-visible context by cache policy:
  - stable system/tool schema/tool exposure/workspace-like static sections first
  - dynamic memory/conversation/plan/compaction/environment after stable prefix
  - ephemeral user request/runtime reminders last
- Preserve section source, cache class, and section hash metadata in request
  fragments and bounded diagnostics.
- Extend cache diagnostics with cache boundary, first changed section, section
  hashes, and estimated cacheable prefix.
- Extend doctor context diagnostics to flag missing cache metadata in trace rows.
- Update `docs/hermes-parity-roadmap.md` after the slice completes.

## Non-Goals

- Do not implement provider-specific paid prompt-cache APIs.
- Do not implement context budget trimming; that is the next roadmap slice.
- Do not productize ACP, remote agents, browser/computer-use, cron, or packaging.
- Do not copy Hermes-agent code.

## Acceptance Criteria

- Same workspace/tools with different current user requests keeps stable prefix
  hash unchanged.
- Workspace instruction changes are identified as the first changed cache
  section.
- Request-shape tests cover static/dynamic/ephemeral ordering and metadata.
- Cache diagnostics trace includes bounded cache boundary metadata and estimated
  cacheable prefix.
- Doctor reports cache metadata completeness from context/cache diagnostic
  traces without printing raw context content.
- Relevant Python tests pass.
