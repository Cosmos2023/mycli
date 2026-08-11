# Tool Manifest Contract

## Overview

`mycli` exposes built-in local tools through a stable read-only manifest. The
manifest is the source of truth for local tool ids, toolset grouping, provider
schema metadata, risk policy metadata, effect profile, and availability.

`ToolsetRegistry` exposes a second read-only manifest for extension
foundation clients. It groups tools by toolset and reports enablement,
aliases, sources, availability, and conflicts without changing the
provider-visible tool schema.

## Scope / Trigger

Apply this contract when changing:

- `src/mycli/tools/registry.py`
- `src/mycli/tools/base.py`
- built-in tool specs under `src/mycli/tools/`
- approval/safety behavior for built-in tools
- extension manifest discovery
- doctor checks for local tools
- TUI or integration clients that inspect available local tools

## Manifest Shape

`ToolRegistry.manifest()` returns:

- `schema_version`: integer, currently `1`
- `source`: currently `builtin`
- `toolsets`: list of `{id, tool_count}`
- `tools`: list of tool entries

Each tool entry must include:

- `id`: stable id, currently `builtin:<tool-name>`
- `name`: route name used by the model/runtime
- `source`: `builtin`, `contributed`, `provider`, `mcp`, `plugin`, `skill`,
  or `subagent`
- `toolset`: logical grouping such as `file`, `search`, `terminal`, `web`,
  `workflow`, `dev`, or `interaction`
- `description`: provider-visible description
- `parameters`: provider-visible parameter schema rows
- `risk_level`: `low`, `medium`, or `high`
- `approval_policy`: stable policy string such as `auto_allow`,
  `auto_allow_or_request`, or `shell_safety_analysis`
- `capability_tags`: bounded machine-readable tags
- `effects`: filesystem/network/process effect profile
- `availability`: currently `{status: "available"}` for built-in tools
- contributed-tool entries may include `contribution` metadata with bounded
  display name, scope, lifecycle state, and origin fields.

## Contracts

- The manifest is read-only. Building or validating it must not create files,
  logs, sessions, traces, shell processes, provider requests, or network calls.
- Built-in tool ids and names must be unique.
- `ToolRegistry.render_for_model()` remains the provider-facing schema surface;
  manifest additions must not change provider schema ordering or contents unless
  the tool spec itself intentionally changes.
- `ExtensionManifestService.manifest()` includes `tool_manifest` so gateway and
  extension clients can discover local tools without scraping human `/tools`
  output.
- `ExtensionManifestService.manifest()` includes `toolset_manifest` so gateway
  and future MCP/plugin/skills/subagent clients can inspect toolset grouping,
  availability, alias, and conflict state without scraping human output.
- `ToolRegistry.toolset_manifest()` must be read-only and must not alter
  `ToolRegistry.render_for_model()` ordering or provider-visible schema.
- `combined_tool_manifest()` may merge built-in and contributed tool
  registrations into the same manifest shape. This is a discovery view only;
  it does not productize plugin/skills/subagent lifecycle.
- MCP-origin contributed registrations use stable `mcp:<server>:<tool>` tool ids
  and `origin_metadata.server` / `origin_metadata.tool`; the combined manifest
  renders those entries with `source="mcp"` and `toolset="external"` even though
  they flow through the generic provider contribution path.
- Default runtime skill invocation uses the built-in stable `Skill` tool plus
  the model-visible skill catalog. Individual skills must not be registered as
  provider-visible default tools, because adding/removing a skill would mutate
  the stable tool schema and degrade prefix-cache stability.
- Successful `Skill` invocations append the loaded skill instructions as a
  persistent, model-visible transcript message with bounded metadata
  (`kind=skill_instructions`, `cache_class=dynamic`,
  `durability=persistent`, `scope=transcript`). The message must be fenced as a
  loaded skill reference, not rendered as the current user request.
- Skill-origin contributed registrations use stable `skill:<name>` tool ids and
  `origin_metadata.skill` only for legacy/non-default discovery surfaces. The
  combined manifest may render those entries with `source="skill"` and
  `toolset="external"` when such registrations are explicitly supplied, but
  default runtime assembly must not inject per-skill contributed tools.
- MCP discovery diagnostics may start configured local stdio servers through
  the MCP client path. Human-facing doctor output must remain bounded to server
  names, transport kind, counts, status, and failure kind; it must not include
  command args, env values, headers, raw tool arguments, or secret-like values.
- Toolset entries include `id`, `enabled`, `aliases`, `sources`, `tool_count`,
  `tools`, and `availability`.
- `ToolsetRegistry.manifest_issues()` reports malformed toolset rows and
  alias/route conflicts. Conflicts are diagnostic-only in this foundation
  slice; runtime enable/disable enforcement is a later productization step.
- `DoctorService` includes a `tool_manifest` check that validates required
  fields, uniqueness, risk levels, parameter shape, availability, and
  toolset manifest health.
- Doctor output must remain bounded and must not print raw tool arguments,
  file contents, command strings, headers, or secret-like values.

## Validation

Required tests for manifest changes:

- Registry manifest shape, uniqueness, toolset counts, and representative
  entries.
- Toolset manifest shape, enablement, aliases, sources, conflict reporting, and
  representative toolset entries.
- Combined manifest with at least one contributed registration preserving
  builtin entries and contributed source/toolset metadata.
- Combined manifest with at least one MCP-origin contributed registration
  rendered as `source=mcp`, `toolset=external`.
- Combined manifest with at least one skill-origin contributed registration
  rendered as `source=skill`, `toolset=external`.
- Extension manifest exposes `tool_manifest` and the `tools.manifest`
  capability.
- Extension manifest exposes `toolset_manifest` and the `toolsets.manifest`
  capability.
- Doctor reports `tool_manifest=ok` for a valid built-in registry.
- Safety policy remains aligned with manifest risk/approval metadata for core
  local tools.
- Existing tool tests continue to pass.

## Scenario: OpenAI-Compatible Tool Projection

### 1. Scope / Trigger

- Trigger: Changing a provider-visible tool schema, Responses/Chat tool serialization, streamed
  function-call events, or provider continuation projection.

### 2. Signatures

- Node provider input: `ProviderRequest.tools: readonly ToolDefinition[]` and canonical
  `ProviderRequest.items`.
- Responses output: `{type: "function", name, description, parameters}`.
- Chat output: `{type: "function", function: {name, description, parameters}}`.

### 3. Contracts

- A schema with optional properties must use ordinary function-schema mode. Do not set
  `strict: true` unless every property is listed in `required` and optional values have an
  explicitly supported nullable encoding.
- `response.function_call_arguments.delta` and `.done` are non-terminal stream fragments.
  `response.output_item.done.item.arguments` is the authoritative complete argument string.
- HTTP/SSE Responses continuation replays canonical user, function-call, and function-output
  items. Do not send `previous_response_id` unless the selected transport and endpoint explicitly
  advertise that capability.
- Compatibility-only arguments such as `Read.pages` may be ignored for supported file types, but
  must not cause an otherwise valid text read to fail.
- The Node tool loop has no fixed provider-step or total tool-call ceiling by default. It stops on
  a final provider answer, interruption, request timeout/retry exhaustion, protocol failure, or
  persistence failure. Historical `tool_budget_exceeded` records remain decodable.

### 4. Validation & Error Matrix

- Optional property plus `strict: true` -> provider rejects `invalid_function_parameters`.
- Unknown terminal Responses event -> bounded `provider_error` with event type only.
- Function call without a non-empty `call_id` -> `tool_protocol_error` before execution.
- Endpoint without HTTP/SSE previous-response support -> full canonical replay, no
  `previous_response_id`.
- More than eight provider steps or sixteen tool calls -> continue normally while the turn remains
  valid and not interrupted.

### 5. Good/Base/Bad Cases

- Good: A Read schema with optional `pages` is sent without strict mode; streamed argument
  fragments are ignored; `output_item.done` produces one tool call.
- Base: A continuation resends the bounded canonical tool transcript and preserves call ordering.
- Bad: Sending `strict: true` with `required` missing `pages`, or unconditionally sending
  `previous_response_id` to a compatible endpoint.
- Bad: Introducing a Node-only hard call ceiling that terminates a turn Python would continue.

### 6. Tests Required

- Provider unit tests assert optional schemas omit `strict` for Responses and Chat.
- A Responses stream test includes argument delta/done before `output_item.done` and asserts one
  parsed tool call.
- A continuation test asserts no `previous_response_id` and ordered function call/output replay.
- Runtime tests assert successful completion beyond eight provider steps and sixteen tool calls.
- The Node M3 integration test asserts the same request shape, successful Read lifecycle, durable
  transcript, and `python_started=false` in live smoke output.

### 7. Wrong vs Correct

Wrong:

```ts
{ type: "function", parameters: readSchema, strict: true, previous_response_id: responseId }
```

Correct:

```ts
{ type: "function", parameters: readSchema }
// Continuation input replays the canonical function_call and function_call_output items.
```

## Scenario: Codex-Style Node Planning Toolset

### 1. Scope / Trigger

- Trigger: changing the Node planning tool schema, built-in tool ordering, risk/effect metadata,
  provider exposure, or system instructions for multi-step work.

### 2. Signatures

- Provider route: `update_plan({explanation?, plan})`.
- `plan` is the complete ordered list of `{step, status}` rows; status is `pending`,
  `in_progress`, or `completed`.
- Tool result effect: `PlanUpdateEffect {explanation?, items: {id, text, status}[]}`.
- Built-in manifest toolset: `{id: "planning", tool_count: 1}`.

### 3. Contracts

- `update_plan` follows the Codex TODO/checklist protocol. It replaces the displayed plan with the
  complete supplied list; it does not accept Python's historical add/start/complete/remove
  operation payloads.
- `explanation` is optional and bounded to 4,096 characters. `plan` is required, may be empty to
  clear the plan, and contains at most 128 items. Step text is non-empty and bounded to 4,096
  characters, unknown fields are rejected, and at most one item is `in_progress`.
- Generated item ids are deterministic within an update: `step-1`, `step-2`, and so on.
- The manifest classifies the tool as `toolset=planning`, `risk_level=low`,
  `approval_policy=auto_allow`, `supports_parallel_tool_calls=false`, and
  `effects={filesystem:none, network:false, process:false}`.
- Planning is a non-mutating agent checkpoint. It must not trigger mutation approval, file-history
  capture, sandbox escalation, or the subagent mutating-tool checkpoint path.
- The canonical system prompt names `update_plan`, requires the complete current plan on every
  call, and tells the model to keep at most one active step. Simple tasks still skip planning.

### 4. Validation & Error Matrix

- Missing/non-array `plan` or an invalid item -> `invalid_arguments` at the router schema boundary,
  or bounded `invalid_plan` if an adapter is called directly.
- More than one `in_progress` item -> failed `invalid_plan` result with no `PlanUpdateEffect`.
- Empty `plan` -> successful `Cleared plan` result and an empty structured effect.
- Optional explanation omitted/empty -> successful update without an explanation field.

### 5. Good/Base/Bad Cases

- Good: publish completed/current/pending steps as one full plan, then publish the next full state
  after finishing the current step.
- Base: expose `update_plan` to both root and child runtimes through the same manifest order.
- Bad: classify planning as a filesystem mutation or request approval for it.
- Bad: send only the changed row, permit two active rows, or expose both `Plan` and `update_plan`.

### 6. Tests Required

- Manifest tests assert toolset count, stable ordering, exact route/id, schema, non-parallel flag,
  approval policy, and no-effect profile.
- Adapter tests cover a structured full plan, empty clear, invalid item/status, bounds, and multiple
  active rows.
- Runtime composition tests assert root and child provider schemas expose exactly `update_plan`.
- Prompt parity tests assert Node and Python load the same versioned canonical template and that it
  names the complete-plan behavior.

### 7. Wrong vs Correct

#### Wrong

```typescript
await updatePlan({ operation: "complete", item_id: "step-1" });
```

#### Correct

```typescript
await updatePlan({
  explanation: "Implementation finished",
  plan: [
    { step: "Inspect runtime", status: "completed" },
    { step: "Run verification", status: "in_progress" },
  ],
});
```

## Non-goals

This manifest does not productize ACP, browser, or computer-use. M7 includes
local/remote MCP discovery and management, Plugin API v2, skills, and
session-owned subagents. Hosted MCP OAuth, a plugin/skill marketplace, and
skill synchronization remain out of scope.

## Scenario: Node M7 Combined Extension Tools And MCP Schemas

### 1. Scope / Trigger

- Trigger: changes to Node integration registration, `combinedToolManifest`, MCP tool projection,
  stable Skill routing, extension approval metadata, or prompt-driven subagent schemas.
- This boundary combines externally supplied schemas with the host AJV 2020 validator. External
  schema dialect declarations must not be allowed to select an unsupported validator dialect.

### 2. Signatures

- `combinedToolManifest(builtin, registrations) -> CombinedToolManifest`.
- `createMcpToolRegistration(client, descriptor) -> IntegrationRegistration`.
- `createSkillToolRegistration(registry) -> IntegrationRegistration`.
- `SPAWN_AGENT_TOOL_DEFINITION` accepts `task_name`, `message`, and optional `fork_turns`.
- Discovery RPC: `extension.manifest({})`, with optional `tool_manifest` in the response.

### 3. Contracts

- The combined manifest is a frozen copy with `schema_version=1`, `source=combined`, deterministic
  toolset counts, all built-ins in their original order, and contributed tools after them.
- Contributed ids and provider route names must be unique across both built-in and extension tools.
  Extension entries use `toolset=external`, `availability.status=available`, and bounded origin
  metadata. Building the combined view never mutates the built-in manifest or starts a provider.
- The default skill surface contributes exactly one stable `Skill` route. Discovering, adding, or
  removing individual skills changes the catalog, not the provider tool schema.
- MCP accepts object input schemas from the SDK. If the root object contains `$schema`, the host
  projection copies the root and removes only that marker before AJV 2020 compilation. Nested
  schema keywords and the original SDK descriptor remain unchanged.
- MCP schemas still require `type=object`, an object `properties` map, and a `required` array whose
  members are declared properties. The dialect adaptation does not relax schema validation.
- MCP and plugin tools have explicit approval metadata and fail closed when no policy exists.
- Node subagents inherit the parent's resolved model, execution policy, and exposed tools. Agent
  profile discovery and selection are disabled, and the spawn schema does not accept `profile`.
- `spawn_agent` is the only provider-visible child-spawn entry point. `Task` is absent from runtime
  composition, package exports, child tool scope, and provider definitions.
- Node subagents have no implicit provider-step, tool-call, or no-progress budget. Python's
  historical implicit `maxTurns=8` and `noProgressTurnLimit=3` are an approved migration difference.
- `SendMessage` and `SubagentOutput` are absent from runtime composition and provider definitions;
  queue delivery uses `send_message` and terminal results arrive through the durable mailbox.

### 4. Validation & Error Matrix

- Duplicate tool id -> `duplicate_tool_id`; duplicate provider route -> `duplicate_tool_route`.
- Definition id differs from registration id -> `tool_definition_id_mismatch`.
- Invalid/oversized origin metadata -> `invalid_tool_origin` or `tool_origin_too_large`.
- MCP root `$schema` naming Draft-07 -> remove the root marker in the host copy and compile the rest.
- MCP schema missing object shape or with undeclared required names -> `invalid_mcp_tool_schema`.
- Unknown extension approval route -> deny before adapter execution.
- A `profile` property on `spawn_agent` -> `invalid_arguments` before execution.
- Missing subagent budget -> continue without a runtime ceiling.

### 5. Good/Base/Bad Cases

- Good: an SDK descriptor with Draft-07 `$schema`, one required string property, and
  `additionalProperties=false` validates through the shared router while the descriptor still
  retains its original `$schema` value.
- Base: no MCP/plugin config produces the unchanged built-in manifest plus the stable Skill and
  subagent control registrations selected by composition.
- Bad: pass the Draft-07 root marker directly to AJV 2020 and crash during integration startup.
- Bad: recursively delete `$schema` or other schema fields from the external descriptor.
- Bad: add Python's implicit 8-step/3-no-progress defaults to a Node child with no budget.
- Bad: discover `.mycli/agents` or `.mycli/subagents` and let a profile override child instructions,
  model, tools, or budgets.

### 6. Tests Required

- Combined-manifest tests assert ordering, frozen copies, source/toolset metadata, origin bounds,
  duplicate id/route rejection, and built-in immutability.
- MCP adapter tests use a real Draft-07 root marker, assert the descriptor is unchanged, reject `{}`
  when a required property is missing, and accept valid input through `ToolRouter`.
- Composition tests assert explicit extension approval policies and package dependency direction.
- Skill tests assert one stable provider route regardless of catalog size.
- Subagent schema/controller/runtime tests assert `spawn_agent` is the only spawn route, profile
  properties are absent, parent tools are inherited, missing budgets remain empty, and turns can
  exceed the historical Python defaults.
- M7 parity fixtures record the approved Python/Node budget difference rather than normalizing it
  away.

### 7. Wrong vs Correct

#### Wrong

```typescript
const definition = { ...descriptor, inputSchema: descriptor.inputSchema };
spawnAgent({ taskName, message, profileId: "explore" });
```

#### Correct

```typescript
const inputSchema = Object.freeze(Object.fromEntries(
	Object.entries(descriptor.inputSchema).filter(([key]) => key !== "$schema"),
));
spawnAgent({ taskName, message, forkTurns });
```

## Scenario: Node Shell Ripgrep Environment

### 1. Scope / Trigger

- Trigger: changes to Node setup, managed Shell environment construction, ripgrep packaging, or
  cross-platform process lookup.

### 2. Signatures

- `prepareUserRipgrep({destinationRoot, target?, force?, signal?, downloadTimeoutMs?, downloadAttempts?}) -> RipgrepPrepareResult`.
- `resolveRipgrep({platformPackageRoot?, packageRoot?, homeDir?, platform?, architecture?, pathValue?}) -> string | undefined`.
- `initializeRipgrepEnvironment({env?, packageRoot?, homeDir?, platform?, architecture?}) -> RipgrepPathResult`.
- `createShellEnvironment(...) -> {env, diagnostics}`.

### 3. Contracts

- When no package-owned or user-owned binary exists, Node setup prepares ripgrep `15.1.0` under
  `~/.mycli/vendor/ripgrep/<platform>-<architecture>/rg[.exe]` using the same target archives and
  SHA-256 values as the retained Python runtime.
- Preparation uses a bounded download, exact SHA-256 verification, member-only archive extraction,
  an executable staged file, atomic placement, and cleanup of temporary files.
- Provider configuration and credentials are saved before ripgrep preparation. Download,
  verification, extraction, or interruption failure is a bounded non-fatal setup issue and must not
  discard the saved provider state.
- Setup reuses an existing package-owned or user-owned binary without network IO. It downloads the
  user-owned fallback only when both locations are absent; system `PATH` is excluded from this
  preparation decision.
- `@mycli/tools` declares all six platform packages as exact-version optional dependencies. Each
  package under `npm/ripgrep/<target>/` declares one compatible `os`/`cpu` pair and contains only
  `vendor/<platform>-<architecture>/rg[.exe]` plus npm metadata.
- A platform package `prepack` stage downloads and verifies its declared target, then `postpack`
  removes the generated vendor tree. Release staging may use up to three attempts within a
  180-second total timeout; interactive setup retains one attempt and its 60-second default.
- Target archive, checksum, optional package name, npm OS, and npm CPU metadata have one source of
  truth in `RIPGREP_TARGETS`. Tests and the staging script validate every package manifest against it.
- CLI startup initializes the supplied process environment before argument routing, prepending the
  package-owned directory once and exporting `MYCLI_RIPGREP_PATH_DIR`. Managed Shell construction
  independently resolves and reapplies the same directory after environment sanitization.
- Managed Shell lookup order is the current optional platform package, the legacy tools-package
  vendor path, the user-vendored binary, then an executable already present on `PATH`. Lookup
  performs no network IO.
- The selected directory appears exactly once at the front of `PATH`, and
  `MYCLI_RIPGREP_PATH_DIR` names that directory. If no executable is found, the marker is absent.
- Targets are `macos`, `linux`, or `windows` plus normalized `aarch64` or `x86_64`. Windows uses
  `rg.exe`, semicolon-delimited paths, and case-insensitive environment/path matching.
- Shell environment sanitization and the mycli-owned `MYCLI_CI=1` marker remain authoritative;
  ripgrep injection must not reintroduce filtered or secret-like parent variables.

### 4. Validation & Error Matrix

- Existing valid user binary -> reuse it without network IO and report `installed=false`.
- Unsupported platform/architecture -> bounded unsupported-target failure.
- Oversized download/member, non-success HTTP response, checksum mismatch, missing archive member,
  or escaping member path -> reject preparation, remove temporary state, preserve saved setup.
- Optional platform package absent -> try the legacy tools-package path; package binary absent ->
  try the user binary; user binary absent -> try `PATH`; all absent -> preserve the sanitized
  fallback `PATH` without the marker.
- Explicit empty `PATH` -> do not substitute a host default; use only a package/user vendored binary
  if present and remove a stale `MYCLI_RIPGREP_PATH_DIR` marker otherwise.

### 5. Tests Required

- Unit tests cover target/package metadata consistency, lookup priority, duplicate removal, Windows
  behavior, startup injection, empty-PATH isolation, retry cleanup, checksum rejection, tar/zip
  member extraction, atomic install, and setup failure degradation.
- A real child-shell integration test must execute `rg` through the generated managed environment
  and observe `MYCLI_RIPGREP_PATH_DIR`.
- Package smoke must build and inspect all six platform tarballs, assert the tools package no longer
  embeds ripgrep, install only the current platform tarball, and execute its `rg --version` with
  system ripgrep absent from `PATH`.
