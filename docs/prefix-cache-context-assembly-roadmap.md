# Prefix Cache Context Assembly Roadmap

本文档把以下两份设计文档收敛成可执行 phase roadmap：

- [mycli-context-assembly-reference.md](./mycli-context-assembly-reference.md)
- [prefix-cache-request-shape-design.md](./prefix-cache-request-shape-design.md)

目标是把 `mycli` 做成一个 **高 prefix-cache 命中率、跨 LLM provider 兼容、可长期工作的 coding agent**。

核心判断：

```text
prefix-cache-request-shape-design.md 的 5 个 phase 只覆盖 cache/request-shape 视角。
mycli-context-assembly-reference.md 又补充了 canonical timeline、provider-private state、
compact lifecycle、rehydration、error recovery 和 redaction boundary。

因此主线不应压成 5 个 phase，更适合拆成 8 个 phase。
```

当前结论：

```text
P1-P4: 已完成基础 request shape、wire cache policy、diagnostics、runtime adoption
P5: 已完成 canonical persistence
P6-P8: 剩余 provider replay hardening、compact lifecycle、recovery/observability
```

## 总体阶段

| Phase | 名称 | 状态 | 主要目标 |
| --- | --- | --- | --- |
| P1 | Request Shape Foundation | 已完成 | static/dynamic/ephemeral 分层、stable prefix hash、基础 diagnostics |
| P2 | Provider Wire Cache Policy | 已完成 | OpenAI `prompt_cache_key`、Anthropic `cache_control`、wire-only hint |
| P3 | Diagnostics / Redaction / Stability Regression | 已完成 | dry-run compare、doctor/trace redaction、cache stability regression |
| P4 | Runtime Adoption | 已完成 | provider profile/config capability 自动解析，runtime assembly 自动接入 |
| P5 | Canonical Timeline / Persistence Contract | 已完成 | agent-visible context 默认持久化，明确 `api_only` 边界 |
| P6 | Provider Adapter / Replay Hardening | 待做 | Responses/Chat/Anthropic 从同一 timeline 正确投影和降级 |
| P7 | Compact / Rehydration Lifecycle | 待做 | canonical compact engine、cheap pruning、summary + rehydration + tail |
| P8 | Recovery / Productized Observability | 待做 | provider error recovery、真实/半真实 telemetry、CLI/doctor/benchmark 产品化 |

## Phase 1: Request Shape Foundation

状态：已完成。

目标：

- 建立 provider-visible request shape 的稳定顺序。
- 让 stable prefix、dynamic replay、ephemeral tail 有明确 metadata。
- 让当前用户输入、runtime reminder 的变化不污染 stable prefix hash。

范围：

- `RequestShapeBuilder` 成为 provider-visible ordering authority。
- 引入或巩固 fragment cache class：
  - `static` / `STABLE`
  - `dynamic` / `REPLAY`
  - `ephemeral` / `VOLATILE`
- `cacheable_prefix_fragment_ids()` 只允许开头连续 stable fragments。
- current user input 放到 request tail。
- trace/diagnostics 能报告 stable prefix hash 和 section boundary。

验收：

- 修改 current user input 不改变 `cacheable_prefix_hash`。
- 修改 runtime reminder 不改变 `cacheable_prefix_hash`。
- stable fragment 出现在 non-stable fragment 之后时能被测试或诊断捕获。
- provider-free cache smoke 能证明 static fragment hash 稳定。

## Phase 2: Provider Wire Cache Policy

状态：已完成。

目标：

- 把 provider cache hint 加到 wire payload，但不污染 canonical request shape。
- 支持 OpenAI-style `prompt_cache_key` 和 Anthropic-style `cache_control`。

范围：

- OpenAI / compatible lane：
  - 生成 request-level `prompt_cache_key`。
  - full key 只能进入 provider wire/request metadata。
  - trace、doctor、summary、snapshot、dry-run 只能保留 hash/preview。
- Anthropic lane：
  - 在 API payload copy 上应用 `cache_control`。
  - `cache_control` 不写回 canonical timeline。
- provider payload snapshot 保持 redacted。

验收：

- `prompt_cache_key` 不进入 `RequestShape.summary()`。
- Anthropic `cache_control` 不写回 session transcript。
- provider payload snapshot 不包含 raw prompt、raw tool output、secret、完整 key。
- Chat-compatible provider 不收到不支持的 Anthropic cache hint。

## Phase 3: Diagnostics / Redaction / Stability Regression

状态：已完成。

目标：

- 让 prefix-cache 行为可诊断、可回归，而不是靠猜。
- 让 diagnostics 足够有用，但不泄露模型可见正文。

范围：

- redacted dry-run comparison。
- `first_changed_cache_class`。
- cache boundary hash stability。
- provider payload snapshot counts。
- doctor/trace 中的 bounded cache policy fields。
- current user input last 的 request shape contract。

验收：

- dry-run compare 不输出 raw user prompt、raw tool output、secret、完整 provider wire payload。
- doctor 能报告 cacheable prefix、first changed class、provider hint state。
- P1/P2 cache stability regression suite 不回退。

## Phase 4: Runtime Adoption

状态：已完成。

目标：

- 让 P1-P3 primitives 进入正常 runtime request assembly。
- 让 provider capability 从 profile/config 自动解析。

范围：

- provider profile/config 增加 cache hint capability metadata。
- `RequestPipeline` 自动解析 capability 并传给 `RequestShapeBuilder`。
- compatible provider 可禁用 `prompt_cache_key`。
- 不支持 hint 的 provider 不收到 hint。
- provider cache usage telemetry normalization。
- doctor cache policy validation states：
  - `enabled_and_emitted`
  - `disabled_by_policy`
  - `enabled_but_missing`
  - `unsupported`

验收：

- provider profile/config capability resolution 有单测。
- runtime request assembly 使用 resolved capability 有单测。
- provider-free cache smoke 包含 P4 policy/dry-run 字段。
- ruff、mypy、全量 pytest、context/subagent/MCP/plugin/hook smoke 通过。

## Phase 5: Canonical Timeline / Persistence Contract

状态：已完成。

目标：

- 把文档中的核心不变量落地：**agent-visible context 默认持久化**。
- 明确 request-scoped、turn-scoped、session-scoped、transcript-scoped 的边界。
- 避免“模型这一轮看过，但 transcript 里没有”的断层。

核心规则：

```text
agent 需要持续知道 -> persistent append_only canonical item
只服务传输/缓存/调试 -> api_only
compact 后继续工作所需内容 -> rehydration item
```

范围：

- 定义 canonical timeline item 的持久化 contract：
  - role/kind
  - source
  - durability
  - cache_class
  - metadata
  - provider_state
- hook/plugin additional context 如果影响后续工作，进入 durable timeline。
- selected memory / plan context 如果由外部模块提供，进入 developer item 并可 replay。
- current user input、assistant output、tool call/result 继续作为 append-only transcript。
- trace id、request id、retry notice、transport hint 等只进 `api_only`。
- compact rehydration 区分 durable rehydration 与 turn rehydration。

不做：

- 不实现完整 memory system。
- 不实现 background maintenance。
- 不实现 multimodal tool result envelope。
- 不实现 provider-specific compact engine。

验收：

- Codex/Responses request 中 hook/plugin additional context 会进入 persisted timeline。
- 外部已选中的 memory/plan context 会作为 developer item replay 到下一 turn。
- `api_only` 内容不会出现在 model-visible timeline replay 中。
- turn-scoped rehydration 不跨后续用户 turn 泄漏。
- transcript-scoped rehydration 会在后续 request replay。
- session resume 后，persistent canonical items 仍可重建 provider request shape。

风险：

- 如果所有 runtime 状态都持久化，会污染 replay 并拖垮 context。
- 如果该持久化的不持久化，会造成 agent 连续性断层。
- P5 的重点是 durability classification，不是“把所有东西都塞进 prompt”。

## Phase 6: Provider Adapter / Replay Hardening

状态：待做。

目标：

- 保证 Responses / Chat Completions / Anthropic 都从同一 canonical timeline 投影。
- provider-private state 只能进入支持它的 adapter，不能互相污染。
- 降级必须显式、可诊断，而不是悄悄丢 context。

范围：

### OpenAI Responses-style lane

- replay same-issuer `codex_reasoning_items`。
- replay same-shape `codex_message_items`：
  - provider supplied `id`
  - `phase`
  - `status`
  - output text blocks
- include `reasoning.encrypted_content` 时只在 same issuer 下回放。
- foreign issuer reasoning state 发送前过滤。

### OpenAI-compatible Chat Completions lane

- 从 canonical timeline 降级为 `messages[]`。
- provider 支持 `developer` role 时使用 developer。
- provider 不支持 developer 时，显式降级到 system block 或 high-priority user block。
- 剥离 Responses 私有字段：
  - `codex_reasoning_items`
  - `codex_message_items`
  - response item id / phase / provider-only metadata
- 剥离 Anthropic thinking/cache fields。

### Anthropic Messages lane

- 从 canonical timeline 渲染 system + messages。
- developer/system 内容按 adapter policy 折叠，不丢 persistent context。
- 只在 wire copy 上应用 `system_and_3` cache_control。
- third-party Anthropic-compatible provider 不支持某些 marker 时安全跳过。

### 通用 adapter hardening

- fallback tool call id / response item id 使用 deterministic hash。
- provider-visible replay 中禁止随机 UUID。
- adapter 必须 schema-sanitize，不把 provider 不认识的字段“试着发过去”。

验收：

- OpenAI Responses 保留并 replay same-issuer encrypted reasoning state。
- OpenAI Responses 保留并 replay `codex_message_items`。
- Chat Completions adapter 不伪造标准不存在的 `reasoning.encrypted_content`。
- Chat Completions adapter 会剥离 Responses / Anthropic 私有字段。
- Anthropic adapter replay 同一份 canonical context，但 `cache_control` 只在 wire copy。
- fallback id 对重复输入稳定。
- provider-private fields 不泄漏进 unsupported wire adapter。

风险：

- Provider state 过早压平成普通文本，会破坏 Responses lane 连续性。
- Provider state 泄漏给不支持的 provider，会导致 400 或隐性行为漂移。
- Chat lane 的降级必须保守，因为 OpenAI-compatible provider 能力差异很大。

## Phase 7: Compact / Rehydration Lifecycle

状态：待做。

目标：

- 让长任务上下文增长后可以安全 compact。
- compact 只 rewrite history 区，不污染 frozen/stable 区。
- compact 后 agent 通过 `summary + rehydration + tail` 继续工作。

默认策略：

```text
canonical timeline
  -> deterministic cheap pruning
  -> summary generation
  -> rehydration selection
  -> tail protection
  -> replacement canonical timeline
  -> provider adapter projection
```

范围：

### Compact 前 cheap pruning

- 只作用于 dynamic replay 区。
- 旧 text / structured text tool output 转结构化摘要。
- 重复 tool result 去重，旧项改为 back-reference。
- 大型 tool_call arguments 在 JSON 内截断，并保持 JSON 有效。
- 最新 tail 保留原始内容。
- tool_call/tool_result group 不切断。

### Summary

- 生成 `assistant summary` 或 `summary item`。
- `metadata.compaction=true`。
- persisted and replayable。
- provider-private reasoning state 不进入自然语言 summary。

### Rehydration

- durable rehydration：
  - current objective
  - active plan state
  - selected memory
  - invoked skill body needed after compact
  - important file summaries
  - unresolved tool/task state
- turn rehydration：
  - 只服务 compact 后当前 turn continuation。

### Tail protection

- frozen system 不变。
- 最近 user message 必须保留在 tail，不能只出现在 summary。
- tool_call/tool_result group 不切断。
- tail 优先按 token budget，message count 只是最低保护线。

### Lifecycle

- `before_compact`：
  - trace compact reason、token pressure、boundary。
  - future memory/context engines 有机会抢救信息。
- `compact`：
  - summary + rehydration + tail。
- `after_compact`：
  - session lineage 更新。
  - context engines 收到 session switch。
  - tool/file-read dedup 状态按需清理。

不做：

- 不默认启用 `/responses/compact`。
- 不为 Responses / Chat / Anthropic 分三套 compact engine。
- 不实现 multimodal payload shrink。

验收：

- compact 后 active conversation 是 `summary + rehydration + tail`。
- frozen system 在 compact 前后 hash 不变。
- stable workspace/tool/catalog hash 不变。
- pre-compact pruning 不改变 `cacheable_prefix_hash`。
- invoked skill body 被 compact 掉但当前任务仍需要时，会进入 rehydration。
- tail message 保留 tool_call/tool_result 成对关系。
- compact 前 cheap pruning 不破坏 tool_call arguments JSON。
- compact summary 失败时默认 abort，不静默删除历史。
- fallback marker 如果启用，必须带 failure metadata 和用户/doctor 可见 warning。

风险：

- P7 是剩余阶段中最重的部分。
- 错误 compact 比不 compact 更危险，因为它会制造“看似继续、实际丢上下文”的问题。
- compact engine 必须优先 correctness，其次才是压缩率和成本。

## Phase 8: Recovery / Productized Observability

状态：待做。

目标：

- 把 P1-P7 的能力变成可诊断、可长期回归的产品层。
- provider error 不在 adapter 中散落字符串匹配，而是统一分类和恢复。
- dry-run / doctor / benchmark 成为日常使用 surface。

范围：

### ErrorClassifier / RecoveryPolicy

统一分类：

- `invalid_encrypted_content`
- `context_overflow`
- `schema_rejected`
- `unsupported_payload`
- `image_too_large`，本主线只 surface，不处理 multimodal recovery

恢复策略：

- `invalid_encrypted_content`：
  - strip encrypted reasoning replay state。
  - disable session replay。
  - retry once without encrypted reasoning。
- `context_overflow`：
  - compact or shrink payload。
  - retry。
- `schema_rejected`：
  - deterministic adapter sanitize repair。
  - only retry if repair is deterministic。

### Productized diagnostics

- CLI dry-run command 或等价本地诊断入口。
- doctor detail view：
  - provider lane
  - cache boundary hash stability
  - prompt_cache_key hash stability
  - first_changed_cache_class
  - wire hint state
  - provider cached tokens latest/max
  - missing telemetry 状态
- benchmark/regression report：
  - repeated turn shape stability
  - tool schema hash stability
  - internal prefix hashes
  - provider cached tokens when available

### Redaction boundary

以下位置必须经过统一 redaction：

- assistant content 入 timeline 前。
- tool result 入 timeline 前。
- compact summary 持久化前。
- request/response debug dump 写盘前。
- future memory extraction / session search 索引前。

provider-private encrypted state 不做自然语言 redaction 改写；要么 opaque 保存，要么整体丢弃。

验收：

- provider error `invalid_encrypted_content` 会禁用 encrypted reasoning replay 并重试一次。
- `context_overflow` 会触发 compact/shrink recovery，而不是直接失败。
- `schema_rejected` 只在 deterministic repair 可用时 retry。
- CLI/doctor dry-run 不输出 raw prompt、raw tool output、secret、完整 `prompt_cache_key`。
- provider telemetry 不可用时，doctor 显示 missing telemetry，而不是误报失败。
- real 或 semi-real provider smoke 可以补充 cache usage，但默认测试仍 provider-free。
- benchmark 能长期比较 internal hash 与 provider usage。

风险：

- 真实 provider telemetry temporally unstable，不能作为唯一单测 oracle。
- CLI/doctor 如果输出太多，会越过 redaction boundary。
- Recovery retry 必须有上限，避免把 provider 错误变成无限循环。

## Deferred Tracks

以下内容不计入 P1-P8 主线，后续单独开任务更合理。

### Memory System

不在本主线实现：

- memory provider lifecycle。
- background memory extraction。
- session search / index。
- memory relevance ranking。

本主线只保证：

```text
如果外部模块提供 selected memory context，
request shape 和 canonical timeline 能按 dynamic/persistent item 承载它。
```

### Background Maintenance

不在本主线实现：

- background prefetch。
- skill curator。
- automatic context cleanup daemon。
- long-running maintenance workers。

### Multimodal Tool Result Envelope

不在本主线实现：

- image/screenshot provider projection。
- historical image placeholder。
- multimodal payload shrink。
- image_too_large recovery。

当前主线只处理 text / structured text tool result 的 replay、pruning 和 redaction。

### Provider-Specific Compact Experiment

`/responses/compact` 只作为 future experiment。

启用前必须证明：

- replacement timeline 满足 canonical compact invariants。
- rehydration 和 tail boundary 正确。
- provider state 过滤正确。
- prefix-cache diagnostics 不回退。
- 失败时不静默删除历史。

## 推荐执行顺序

```text
P5 Canonical Timeline / Persistence Contract
  -> P6 Provider Adapter / Replay Hardening
  -> P7 Compact / Rehydration Lifecycle
  -> P8 Recovery / Productized Observability
```

不要先做 P7 compact，再补 P5/P6。原因：

- compact 依赖 canonical durability 和 provider_state 边界。
- provider replay hardening 没完成时，compact 可能把 provider-private state 错误压成普通文本。
- error recovery 依赖 compact 和 adapter sanitize 的明确 contract。

## 工作量估算

粗略估算：

| Phase | 工作量 | 风险 |
| --- | --- | --- |
| P5 | 2-4 天 | 中 |
| P6 | 3-5 天 | 中高 |
| P7 | 4-8 天 | 高 |
| P8 | 2-5 天 | 中 |

合计：

```text
做到可用闭环: 约 2 周
做到接近 Hermes/Codex 长任务稳定性: 约 3-4 周
```

## 完成定义

整条主线完成时，应满足：

- 同一 session 中，frozen/stable prefix 在普通 turn 之间稳定。
- current user input、runtime reminder、approval/tool-loop state 改变时，不改变 stable prefix hash。
- agent-visible hook/plugin/memory/plan selected context 可持久化、可 replay、可 compact。
- Responses lane 能 same-issuer replay encrypted reasoning 和 message items。
- Chat lane 能显式降级并剥离 unsupported provider-private fields。
- Anthropic lane 能 replay canonical context，并只在 wire copy 上加 `cache_control`。
- compact 后 frozen system 不变，active context 由 `summary + rehydration + tail` 继续。
- compact 前 cheap pruning 不改变 stable prefix hash。
- provider error recovery 走统一 classifier/policy。
- diagnostics 同时报告 internal prefix hashes 和 provider cache usage metrics。
- 所有 diagnostics、doctor、dry-run、snapshot 都满足 redaction boundary。
