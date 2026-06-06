# Prefix Cache Context Assembly Goals

本文档保存 Prefix Cache Context Assembly Roadmap 剩余阶段的可执行 `/goal` 文本。

来源文档：

- [prefix-cache-context-assembly-roadmap.md](./prefix-cache-context-assembly-roadmap.md)
- [mycli-context-assembly-reference.md](./mycli-context-assembly-reference.md)
- [prefix-cache-request-shape-design.md](./prefix-cache-request-shape-design.md)

推荐执行顺序：

```text
P5 -> P6 -> P7a -> P7b -> P8
```

不要先做 P7 compact，再补 P5/P6。compact 依赖 canonical durability、provider_state 边界和 provider adapter projection contract。

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

## Batch Execution Goal

以下 goal 用于分批次完成本文档中的所有阶段。

```text
/goal 当前工作目录为：
/Users/cosmos/Desktop/mycli/.worktrees/mycli-prefix-cache-context-assembly-p1

基于当前分支 feature/mycli-prefix-cache-context-assembly-p1，按批次完成 docs/prefix-cache-context-assembly-goals.md 中保存的 Prefix Cache Context Assembly P5-P8 goals。默认不合入 main，除非我明确说“合吧”。

总目标：
把 mycli Prefix Cache Context Assembly Roadmap 剩余阶段按 P5 -> P6 -> P7a -> P7b -> P8 顺序落地，完成 canonical timeline persistence、provider adapter replay hardening、compact cheap pruning/tail protection、canonical compact summary/rehydration lifecycle、recovery/productized observability，同时保持 P1-P4 的 prefix-cache stability、provider wire cache policy、redaction diagnostics 和 runtime adoption 不回退。

执行方式：
1. 读取并遵守：
   - docs/prefix-cache-context-assembly-goals.md
   - docs/prefix-cache-context-assembly-roadmap.md
   - docs/mycli-context-assembly-reference.md
   - docs/prefix-cache-request-shape-design.md
   - .trellis/spec/backend/context-management-contract.md
2. 走 Trellis：research -> PRD -> implementation -> tests -> archive。
3. 必须按批次推进：
   - Batch 1 / P5：Canonical Timeline / Persistence Contract
   - Batch 2 / P6：Provider Adapter / Replay Hardening
   - Batch 3 / P7a：Compact Cheap Pruning / Tail Protection Foundation
   - Batch 4 / P7b：Canonical Compact Summary / Rehydration Lifecycle
   - Batch 5 / P8：Recovery / Productized Observability
4. 每个 batch 都要有独立的 research/PRD、测试证据、提交和阶段报告。
5. 每个 batch 完成后先运行相关 focused tests 和 provider-free smoke；P8 完成后再运行全量质量门。
6. 禁止把 P5-P8 混成一个不可审查的大 diff；如果发现 scope 超出单批次，先切更小 subtask。

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
- P5 canonical timeline / durability / `api_only` / rehydration scope 有单测。
- P6 Responses replay、Chat 降级剥离、Anthropic wire-only cache_control、deterministic fallback id、schema sanitize 有单测。
- P7a cheap pruning、JSON 截断、重复 result 去重、tail group 保护、stable prefix invariant 有单测。
- P7b summary replacement、rehydration scope、tail protection、compact failure safety、lineage/trace、stable prefix invariant 有单测。
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
