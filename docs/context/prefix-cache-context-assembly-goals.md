# Prefix Cache Context Assembly Goals

本文档保存 Prefix Cache Context Assembly Roadmap 各阶段的可执行 `/goal` 文本，并记录当前推荐的分批执行入口。

用途：

- 保存 P5-P8 的单阶段 goals，方便后续复查每个 phase 的边界。
- 保存一版“一口气完成 P5-P8”的原始大 goal，作为归档参考。
- 提供当前分支最适合继续执行的 phased master goal：按批次推进，已完成阶段只回归不重做。

来源文档：

- [prefix-cache-context-assembly-roadmap.md](./prefix-cache-context-assembly-roadmap.md)
- [mycli-context-assembly-reference.md](./mycli-context-assembly-reference.md)
- [prefix-cache-request-shape-design.md](./prefix-cache-request-shape-design.md)

推荐执行顺序：

```text
P5 -> P6 -> P7a -> P7b -> P8
```

不要先做 P7 compact，再补 P5/P6。compact 依赖 canonical durability、provider_state 边界和 provider adapter projection contract。

## Current Progress Snapshot

截至 2026-06-06 当前 worktree 状态：

- P5 已完成、提交、归档、journal 记录。
- P6 已完成、提交、归档、journal 记录。
- P7a 已完成、提交、归档、journal 记录。
- P7b 已完成、提交、归档、journal 记录。
- P8 已完成、提交、归档。核心实现提交：`b8f2b76 Recover provider replay without leaking context`。
- P8 最终质量门已通过：ruff、mypy、全量 pytest、provider-free cache smoke、context/subagent/MCP/plugin/hook smoke。

继续执行时不应重新实现 P5/P6/P7a/P7b/P8。后续只需要基于新的产品范围另开任务。

## P5 Goal

状态：已完成。完成记录见
`.trellis/tasks/archive/2026-06/06-06-06-06-prefix-cache-context-assembly-p5/completion.md`
（归档前路径为
`.trellis/tasks/06-06-06-06-prefix-cache-context-assembly-p5/completion.md`）。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支 feature/mycli-prefix-cache-context-assembly-p1，实现 Prefix Cache Context Assembly P5：Canonical Timeline / Persistence Contract。默认不合入 main。

目标：
落地 agent-visible context 默认持久化的 canonical timeline contract，明确 persistent / api_only / turn-scoped / transcript-scoped 边界，让 hook/plugin selected context、外部 selected memory/plan context、current user、assistant、tool call/result 都能作为后续可 replay 的上下文进入 timeline。

范围：
- 定义 canonical timeline item contract：role/kind、source、durability、cache_class、metadata、provider_state。
- 明确 `api_only` 内容不进入 model-visible replay。
- hook/plugin selected context 按 durable developer item 持久化。
- 外部 selected memory/plan context 可作为 developer item replay。
- compact rehydration 区分 durable 与 turn-scoped。
- session resume 后 persistent items 能重建 request shape。

不做：
完整 memory system、background maintenance、多模态 envelope、provider-specific compact。

验收：
P5 相关单测、provider-free smoke、P1-P4 regression 不回退，ruff/mypy/pytest 通过，Trellis archive + journal。
```

## P6 Goal

状态：已完成、提交、归档、journal 记录。完成记录见
`.trellis/tasks/archive/2026-06/06-06-prefix-cache-context-assembly-p6/completion.md`。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支继续实现 Prefix Cache Context Assembly P6：Provider Adapter / Replay Hardening。默认不合入 main。

目标：
让 Responses / Chat Completions / Anthropic 都从同一 canonical timeline 做安全投影；provider-private state 只能通过 provider_state 专用通道进入支持它的 adapter，不泄漏到不支持的 provider。

范围：
- Responses lane replay same-issuer `codex_reasoning_items` 和 same-shape `codex_message_items`。
- foreign issuer encrypted reasoning 发送前过滤。
- Chat lane 降级为 `messages[]`，支持 developer role 时用 developer，不支持时显式降级。
- Chat lane 剥离 Responses / Anthropic 私有字段、内部 `_` 字段、provider-only metadata。
- Anthropic lane 从 canonical timeline 渲染 system + messages，`cache_control` 只加在 wire copy。
- fallback tool call id / response item id 使用 deterministic hash。
- adapter schema-sanitize，不向 provider 发送不支持字段。

验收：
Responses replay、Chat 降级剥离、Anthropic wire-only cache_control、deterministic fallback id、schema sanitize 单测通过；全量质量门通过。
```

## P7a Goal

状态：已完成、提交、归档、journal 记录。完成记录见
`.trellis/tasks/archive/2026-06/06-06-prefix-cache-context-assembly-p7a/completion.md`。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支实现 Prefix Cache Context Assembly P7a：Compact Cheap Pruning / Tail Protection Foundation。默认不合入 main。

目标：
先实现 compact 前的 deterministic cheap pruning 和 tail boundary 保护，为后续 summary + rehydration 打基础，同时保证 frozen/stable prefix 不变。

范围：
- cheap pruning 只作用 dynamic replay 区。
- 旧 text / structured text tool output 转结构化摘要。
- 重复 tool result 去重，旧项改 back-reference。
- 大型 tool_call arguments 在 JSON 内截断并保持 JSON 有效。
- 最新 tail 保留原始内容。
- tool_call/tool_result group 不切断。
- frozen system、stable workspace、stable skill catalog、tool schema 不被 pruning。
- pruning 后重新计算 replay/compact diagnostics，但 `cacheable_prefix_hash` 不变。

验收：
cheap pruning、JSON 截断、重复 result 去重、tail group 保护、stable prefix invariant 单测通过；P1-P6 regression 不回退。
```

## P7b Goal

状态：已完成、提交、归档、journal 记录。完成记录见
`.trellis/tasks/archive/2026-06/06-06-prefix-cache-context-assembly-p7b/completion.md`。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支实现 Prefix Cache Context Assembly P7b：Canonical Compact Summary / Rehydration Lifecycle。默认不合入 main。

目标：
完成 canonical compact engine 主路径：summary + durable/turn rehydration + protected tail，compact 后 agent 能继续工作且不污染 frozen/stable prefix。

范围：
- canonical timeline -> cheap pruning -> summary generation -> rehydration selection -> tail protection -> replacement canonical timeline。
- summary item 持久化，带 `metadata.compaction=true`。
- provider-private reasoning state 不进入自然语言 summary。
- durable rehydration 支持 current objective、active plan、selected memory、required invoked skill body、important file summaries、unresolved task state。
- turn rehydration 只服务当前 continuation。
- before_compact / after_compact lifecycle trace：reason、token pressure、boundary、lineage。
- compact summary 失败默认 abort，不静默删除历史；fallback marker 如启用必须带 failure metadata 和 warning。
- 不启用 `/responses/compact`，不做 provider-specific compact engine。

验收：
summary replacement、rehydration scope、tail protection、compact failure safety、lineage/trace、stable prefix invariant 单测通过；全量质量门通过。
```

## P8 Goal

状态：已完成、提交、归档。完成记录见
`.trellis/tasks/archive/2026-06/06-06-prefix-cache-context-assembly-p8/completion.md`
（归档前路径为 `.trellis/tasks/06-06-prefix-cache-context-assembly-p8/completion.md`）。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支实现 Prefix Cache Context Assembly P8：Recovery / Productized Observability。默认不合入 main。

目标：
把 P5-P7 的上下文与缓存能力产品化为可诊断、可恢复、可长期回归的 runtime surface。

范围：
- 增加统一 ErrorClassifier / RecoveryPolicy：
  invalid_encrypted_content、context_overflow、schema_rejected、unsupported_payload、image_too_large。
- invalid encrypted content：strip encrypted reasoning replay state，disable session replay，retry once。
- context overflow：compact or shrink payload，然后 retry。
- schema rejected：只在 deterministic adapter sanitize repair 可用时 retry。
- CLI dry-run command 或等价本地诊断入口。
- doctor detail view：provider lane、cache boundary stability、prompt_cache_key hash stability、first_changed_cache_class、wire hint state、cached tokens latest/max、missing telemetry。
- benchmark/regression report。
- 统一 redaction boundary：timeline 入库、tool result、compact summary、debug dump、future memory/index 边界。
- full `prompt_cache_key` 不进入 trace/doctor/dry-run/snapshot/persisted timeline。

验收：
RecoveryPolicy、doctor detail、dry-run/benchmark diagnostics、redaction boundary 单测通过；provider-free smoke 覆盖 P5-P8 字段；ruff/mypy/pytest 和 context/subagent/MCP/plugin/hook smoke 全通过；Trellis archive + journal；输出最终报告。
```

## Current Branch Phased Master Goal

以下 goal 用于当前分支从 P8 归档前状态继续，按批次完成剩余收尾工作。当前分支已经执行过该 goal：P8 archive 已完成，最终质量门已通过，后续不应重复执行。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支 feature/mycli-prefix-cache-context-assembly-p1，按批次完成 docs/context/prefix-cache-context-assembly-goals.md 中保存的 Prefix Cache Context Assembly 剩余收尾工作。默认不合入 main，除非我明确说“合吧”。

总目标：
把 mycli Prefix Cache Context Assembly Roadmap 从当前状态收尾：P5/P6/P7a/P7b 已完成，不重做；P8 core implementation/tests 已完成并提交，继续完成 P8 Trellis archive、journal、最终质量门和最终报告，确保 P1-P8 的 prefix-cache stability、provider wire cache policy、redaction diagnostics、runtime adoption、canonical persistence、provider replay hardening、compact lifecycle、recovery/productized observability 都不回退。

执行方式：
1. 读取并遵守：
   - docs/context/prefix-cache-context-assembly-goals.md
   - docs/context/prefix-cache-context-assembly-roadmap.md
   - docs/context/mycli-context-assembly-reference.md
   - docs/context/prefix-cache-request-shape-design.md
   - .trellis/spec/backend/context-management-contract.md
2. 走 Trellis：确认已有 research/PRD/implementation/tests -> archive -> journal -> final report。
3. 必须按批次推进：
   - Batch 0 / Resume audit：检查 `git status --short`、`git log --oneline -8`、`.trellis/tasks/06-06-prefix-cache-context-assembly-p8/task.json`、P8 `completion.md`，确认没有未记录实现 diff。
   - Batch 1 / P8 archive：归档 `.trellis/tasks/06-06-prefix-cache-context-assembly-p8`，保留 completion evidence，不改动实现代码；提交 archive bookkeeping commit。
   - Batch 2 / Journal：把 P8 完成摘要、提交、测试证据、剩余差距记录到 Trellis journal；提交 journal bookkeeping commit。
   - Batch 3 / Final stabilization：跑全量质量门、provider-free cache smoke、context/subagent/MCP/plugin/hook smoke；如失败，按最小 diff 修复并重新验证。
   - Batch 4 / Final report：输出最终报告，包含分支、commits、每个 phase/batch 完成内容、测试结果、剩余 Hermes/Codex cache 差距、下一步建议。
4. 每个 batch 都要保持 diff 聚焦；archive、journal、修复代码、报告不要混在同一个不可审查提交里。
5. 如果 `git status` 显示与当前 batch 无关的新改动，先隔离或记录，不要混入当前 batch commit。

全局规则：
- 不合入 main，除非我明确说“合吧”。
- 不新增第三方依赖。
- 不做真实外部 provider API 调用，除非我单独明确要求。
- Hermes-agent 和 Codex 只作语义参考，不复制代码。
- 优先复用现有 ProviderProfile、AgentConfig、RequestPipeline、RequestShapeBuilder、ProviderRequestPolicyShape、ProviderPayloadSnapshot、ProviderRequestDryRun、CacheShapeDiagnostics、Doctor、Trace、provider adapter/client、session/recovery 抽象。
- full `prompt_cache_key` 不得进入 RequestShape.summary、trace payload、doctor payload、dry-run payload、provider payload snapshot 或普通 persisted canonical timeline；只允许存在于 provider wire/request metadata。
- Anthropic `cache_control` 是 wire-only，不写回 canonical timeline。
- provider-private fields 只能存在于 provider_state 专用通道，不能压平成普通 content。
- compact 不得修改 frozen system、stable workspace rules、stable skill catalog 或 tool schema。
- current user input 必须保持 request tail 顺序。
- memory system、background maintenance、多模态 tool result envelope 不纳入本目标，只保留 selected context/envelope compatibility boundary。
- `/responses/compact` 只作为 future experiment，不进入默认路径。

最终验收：
- P5 canonical timeline / durability / `api_only` / rehydration scope 已完成且 regression 不回退。
- P6 Responses replay、Chat 降级剥离、Anthropic wire-only cache_control、deterministic fallback id、schema sanitize 已完成且 regression 不回退。
- P7a cheap pruning、JSON 截断、重复 result 去重、tail group 保护、stable prefix invariant 已完成且 regression 不回退。
- P7b summary replacement、rehydration scope、tail protection、compact failure safety、lineage/trace、stable prefix invariant 已完成且 regression 不回退。
- P8 ErrorClassifier/RecoveryPolicy、doctor detail、dry-run/benchmark diagnostics、redaction boundary 有单测。
- provider-free cache smoke 通过，并覆盖 P5-P8 关键字段。
- P1-P4 cache stability regression suite 不回退。
- context / subagent / MCP / plugin / hook smoke 通过。
- `uv run ruff check .` 通过。
- `uv run mypy src/mycli` 通过。
- `uv run pytest -q` 全量通过。
- Trellis tasks 完成 archive，journal 已记录。
- 输出最终报告：分支、commits、每个 batch 完成内容、测试结果、剩余 Hermes/Codex cache 差距、下一步建议。
```

## Full Roadmap Staged Master Goal

以下 goal 适合从 P5 前置状态重新执行，或交给一个 agent 在新分支上按阶段推进完整 roadmap。当前分支不推荐直接使用它，因为 P5-P7b 已完成，P8 core implementation/tests 也已完成。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支 feature/mycli-prefix-cache-context-assembly-p1，按批次完成 docs/context/prefix-cache-context-assembly-goals.md 中保存的 Prefix Cache Context Assembly P5-P8 goals。默认不合入 main，除非我明确说“合吧”。

总目标：
把 mycli Prefix Cache Context Assembly Roadmap 按 P5 -> P6 -> P7a -> P7b -> P8 顺序落地，完成 canonical timeline persistence、provider adapter replay hardening、compact cheap pruning/tail protection、canonical compact summary/rehydration lifecycle、recovery/productized observability，同时保持 P1-P4 的 prefix-cache stability、provider wire cache policy、redaction diagnostics 和 runtime adoption 不回退。

执行方式：
1. 读取并遵守：
   - docs/context/prefix-cache-context-assembly-goals.md
   - docs/context/prefix-cache-context-assembly-roadmap.md
   - docs/context/mycli-context-assembly-reference.md
   - docs/context/prefix-cache-request-shape-design.md
   - .trellis/spec/backend/context-management-contract.md
2. 走 Trellis：research -> PRD -> implementation -> tests -> archive。
3. 按以下 batch 顺序推进；每个 batch 都要独立 task 或明确 phase evidence、独立提交、独立归档、独立 journal：
   - Batch 1 / P5：Canonical Timeline / Persistence Contract。
   - Batch 2 / P6：Provider Adapter / Replay Hardening。
   - Batch 3 / P7a：Compact Cheap Pruning / Tail Protection Foundation。
   - Batch 4 / P7b：Canonical Compact Summary / Rehydration Lifecycle。
   - Batch 5 / P8：Recovery / Productized Observability。
   - Batch 6 / Final stabilization：全量质量门、smoke、最终报告。
4. 每个 batch 开始前检查 git status 和已有 Trellis task；如果该 batch 已完成，只跑必要 regression 并记录 skip reason，不重做。
5. 每个 batch 完成后运行 focused tests 和相关 provider-free smoke；Batch 6 运行完整质量门。
6. 不合入 main，不新增第三方依赖，不做真实 provider API 调用，不复制 Hermes-agent 或 Codex 代码。
7. P8 完成后运行 ruff、mypy、全量 pytest、provider-free cache smoke、context/subagent/MCP/plugin/hook smoke，并输出最终报告。

全局不变量：
- full `prompt_cache_key` 不进入 RequestShape.summary、trace payload、doctor payload、dry-run payload、provider payload snapshot 或普通 persisted canonical timeline；只允许存在于 provider wire/request metadata。
- Anthropic `cache_control` 是 wire-only，不写回 canonical timeline。
- provider-private fields 只能存在于 provider_state 专用通道，不能压平成普通 content。
- compact 不得修改 frozen system、stable workspace rules、stable skill catalog 或 tool schema。
- current user input 必须保持 request tail 顺序。
- memory system、background maintenance、多模态 tool result envelope 不纳入本目标，只保留 selected context/envelope compatibility boundary。
- `/responses/compact` 只作为 future experiment，不进入默认路径。

最终验收：
- P5-P8 单测和 regression 全部通过。
- provider-free cache smoke 通过，并覆盖 P5-P8 关键字段。
- context / subagent / MCP / plugin / hook smoke 通过。
- `uv run ruff check .` 通过。
- `uv run mypy src/mycli` 通过。
- `uv run pytest -q` 全量通过。
- Trellis tasks 完成 archive，journal 已记录。
- 输出最终报告：分支、commits、每个 batch 完成内容、测试结果、剩余 Hermes/Codex cache 差距、下一步建议。
```

## Original One-Shot P5-P8 Goal

以下 goal 保存一版“一口气完成 P5-P8”的原始大目标，适合作为归档参考。实际执行时优先使用上面的 staged master goal。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支 feature/mycli-prefix-cache-context-assembly-p1，继续推进并一次性完成 mycli Prefix Cache Context Assembly Roadmap P5-P8。默认不合入 main，除非我明确说“合吧”。

参考文档：
- docs/context/prefix-cache-context-assembly-roadmap.md
- docs/context/mycli-context-assembly-reference.md
- docs/context/prefix-cache-request-shape-design.md
- .trellis/spec/backend/context-management-contract.md

背景：
P1-P4 已经完成 request shape foundation、provider wire cache policy、redacted diagnostics/stability regression、runtime provider cache policy adoption。现在要把剩余 roadmap 一次性落地：canonical timeline persistence、provider adapter replay hardening、canonical compact/rehydration lifecycle、recovery/productized observability。

总目标：
把 mycli 的上下文系统完成到可长期工作的 cache-aware multi-provider coding agent 水平：agent-visible context 可持久化、可 replay、可 compact、可复水；Responses / Chat Completions / Anthropic 从同一 canonical timeline 做安全投影；prefix-cache stable boundary 不被 dynamic/ephemeral/compact/recovery 污染；diagnostics/doctor/dry-run/trace 在不泄露 raw prompt/secret/full key 的前提下可长期回归。

范围：

P5 Canonical Timeline / Persistence Contract
1. 落地 canonical timeline item contract：role/kind、source、durability、cache_class、metadata、provider_state。
2. 明确 request-scoped、turn-scoped、session-scoped、transcript-scoped 边界。
3. agent-visible context 默认持久化：hook/plugin selected context、外部提供的 selected memory/plan context、current user input、assistant output、tool call/result。
4. 明确 `api_only` 内容：trace id、request id、retry notice、transport hint、provider wire-only cache hint。
5. compact rehydration 区分 durable rehydration 与 turn-scoped rehydration。
6. session resume 后 persistent canonical items 能重建 provider request shape。
7. 不实现完整 memory system、background maintenance、多模态 envelope。

P6 Provider Adapter / Replay Hardening
1. OpenAI Responses-style lane：
   - replay same-issuer `codex_reasoning_items`
   - replay same-shape `codex_message_items`
   - same issuer 才发送 encrypted reasoning state
   - foreign issuer provider_state 发送前过滤
2. Chat Completions lane：
   - 从 canonical timeline 降级为 `messages[]`
   - provider 支持 developer role 时使用 developer
   - 不支持 developer 时显式降级到 system block 或 high-priority user block
   - 剥离 Responses 私有字段、Anthropic thinking/cache fields、内部 `_` 字段、provider-only metadata
3. Anthropic Messages lane：
   - 从 canonical timeline 渲染 system + messages
   - developer/system 内容按 adapter policy 折叠，但不能丢 persistent context
   - `cache_control` 只在 wire copy 上应用，不写回 transcript
   - third-party Anthropic-compatible provider 不支持 marker 时安全跳过
4. 通用 adapter hardening：
   - fallback tool call id / response item id 使用 deterministic hash
   - provider-visible replay 禁止随机 UUID
   - adapter schema-sanitize，不向 provider 发送不支持字段

P7 Compact / Rehydration Lifecycle
1. 实现或补齐 canonical compact engine 主路径：
   canonical timeline -> deterministic cheap pruning -> summary generation -> rehydration selection -> tail protection -> replacement canonical timeline -> provider adapter projection
2. cheap pruning 只作用 dynamic replay 区：
   - 旧 text / structured text tool output 转结构化摘要
   - 重复 tool result 去重，旧项改 back-reference
   - 大型 tool_call arguments 在 JSON 内截断并保持 JSON 有效
   - 最新 tail 保留原始内容
   - tool_call/tool_result group 不切断
3. summary：
   - `metadata.compaction=true`
   - persisted and replayable
   - provider-private reasoning state 不进入自然语言 summary
4. rehydration：
   - durable rehydration 包含 current objective、active plan state、selected memory、required invoked skill body、important file summaries、unresolved tool/task state
   - turn rehydration 只服务 compact 后当前 turn continuation
5. tail protection：
   - frozen system 不变
   - 最近 user message 必须保留在 tail
   - tool_call/tool_result group 不切断
   - token budget 优先，message count 只是最低保护线
6. lifecycle：
   - before_compact 记录 compact reason、token pressure、boundary
   - after_compact 更新 session lineage，清理/通知相关 context state
7. compact summary 失败默认 abort，不静默删除历史；fallback marker 如启用必须带 failure metadata 和 doctor/user-visible warning。
8. 不默认启用 `/responses/compact`，不为 Responses/Chat/Anthropic 分三套 compact engine，不实现 multimodal payload shrink。

P8 Recovery / Productized Observability
1. 增加统一 ErrorClassifier / RecoveryPolicy：
   - `invalid_encrypted_content`
   - `context_overflow`
   - `schema_rejected`
   - `unsupported_payload`
   - `image_too_large` 只 surface，不做 multimodal recovery
2. 恢复策略：
   - invalid encrypted content：strip encrypted reasoning replay state，disable session replay，retry once without encrypted reasoning
   - context overflow：compact or shrink payload，然后 retry
   - schema rejected：只在 deterministic adapter sanitize repair 可用时 retry
3. 产品化 diagnostics：
   - CLI dry-run command 或等价本地诊断入口
   - doctor detail view
   - benchmark/regression report
4. diagnostics 必须展示：
   - provider lane
   - cache boundary hash stability
   - prompt_cache_key hash stability
   - first_changed_cache_class
   - wire hint state
   - provider cached tokens latest/max
   - missing telemetry 状态
5. redaction boundary：
   - assistant content 入 timeline 前
   - tool result 入 timeline 前
   - compact summary 持久化前
   - request/response debug dump 写盘前
   - future memory extraction/session search 索引前
   - provider-private encrypted state 不做自然语言 redaction 改写，只能 opaque 保存或整体丢弃

规则：
- 不合入 main，除非我明确说“合吧”。
- 不新增第三方依赖。
- 不做真实外部 provider API 调用，除非我单独明确要求。
- Hermes-agent 和 Codex 只作语义参考，不复制代码。
- 走 Trellis：research -> PRD -> implementation -> tests -> archive。
- 优先复用现有 ProviderProfile、AgentConfig、RequestPipeline、RequestShapeBuilder、ProviderRequestPolicyShape、ProviderPayloadSnapshot、ProviderRequestDryRun、CacheShapeDiagnostics、Doctor、Trace、provider adapter/client、session/recovery 抽象。
- full `prompt_cache_key` 不得进入 RequestShape.summary、trace payload、doctor payload、dry-run payload、provider payload snapshot 或普通 persisted canonical timeline；只允许存在于 provider wire/request metadata。
- Anthropic `cache_control` 是 wire-only，不写回 canonical timeline。
- provider-private fields 只能存在于 provider_state 专用通道，不能压平成普通 content。
- compact 不得修改 frozen system、stable workspace rules、stable skill catalog 或 tool schema。
- current user input 必须保持 request tail 顺序。
- memory system、background maintenance、多模态 tool result envelope 不纳入本目标，只保留 selected context/envelope compatibility boundary。
- `/responses/compact` 只作为 future experiment，不进入默认路径。

验收：
- P5 canonical timeline / durability / `api_only` / rehydration scope 有单测。
- P6 Responses replay、Chat 降级剥离、Anthropic wire-only cache_control、deterministic fallback id、schema sanitize 有单测。
- P7 cheap pruning、summary replacement、rehydration、tail protection、compact failure safety、stable prefix invariants 有单测。
- P8 ErrorClassifier/RecoveryPolicy、doctor detail、dry-run/benchmark diagnostics、redaction boundary 有单测。
- provider-free cache smoke 通过，并覆盖 P5-P8 关键字段。
- P1-P4 cache stability regression suite 不回退。
- context / subagent / MCP / plugin / hook smoke 通过。
- `uv run ruff check .` 通过。
- `uv run mypy src/mycli` 通过。
- `uv run pytest -q` 全量通过。
- Trellis task 完成 archive，journal 已记录。
- 输出最终报告：分支、commits、完成内容、测试结果、剩余 Hermes/Codex cache 差距、下一步建议。
```
