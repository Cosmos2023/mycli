# Extension Capability Manifest Notes

## Existing State

- `trace.export` is the first direct machine-readable external-consumer RPC.
- The Node gateway already exposes read-only requests such as `status.inspect`,
  `session.list`, `transcript.load`, and `completion.*`.
- Runtime has MCP, skills, sub-agent, approval, session, and trace services,
  but no single discovery document for external clients.

## Design

Add a static, typed service under `services/extensions` that returns a manifest
dictionary. This keeps extension discovery separate from Node gateway transport.

Initial manifest categories:

- `rpc_methods`: current JSON-RPC methods external clients may call.
- `event_streams`: current push/event channels such as `status.update` and
  `approval.request`.
- `capabilities`: coarse integration families, including trace export,
  session inspection/resume, approvals, slash commands, MCP tools, skills, and
  subagents.

## Why Static First

A static manifest is less ambitious than a plugin registry, but it creates a
stable discovery contract that future ACP/extension work can extend. Dynamic
installation and lifecycle management should be separate slices.

## Risks

- Overstating capabilities would mislead external clients. The manifest should
  explicitly mark lifecycle-heavy items as discovery/integration surfaces, not
  installed extensions.
- This worktree is based on the `trace.export` feature branch, not `main`, so
  it intentionally builds on the latest external-consumer groundwork without
  merging to `main`.
