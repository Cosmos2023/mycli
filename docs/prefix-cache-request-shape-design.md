# 面向 Prefix Cache 的 Request Shape 设计

本文档定义 `mycli` 应如何组装面向 provider 的 prompt，使长时间 coding session 在支持动态运行时状态、插件、工具、记忆、计划和诊断的同时，仍能尽量保持 prefix-cache 命中率。

目标不是让每一个 token 都可缓存。目标是让可缓存前缀具备确定性、足够大，并且不被运行时波动破坏。

本文只讨论 provider-visible ordering、cache boundary、shape hash 和诊断指标。上下文语义、持久化边界、provider adapter contract、compact 复水规则见 [mycli-context-assembly-reference.md](./mycli-context-assembly-reference.md)。

核心分工：

```text
mycli-context-assembly-reference.md:
  定义哪些内容进入 canonical timeline，以及各 provider 如何语义投影

prefix-cache-request-shape-design.md:
  定义这些内容以什么顺序、什么稳定性等级进入 provider-visible request
```

## Cache Goal

本文服务于总目标：把 `mycli` 做成一个高 prefix-cache 命中率、跨 LLM provider 兼容、可长期工作的 coding agent。缓存层的具体目标是：

```text
stable prefix 尽可能长
dynamic replay 尽可能有界
ephemeral context 尽可能靠后
provider payload 尽可能可预测
compact rewrite 不污染 stable prefix
```

### 可验证目标

实现时必须能用自动化测试或 smoke diagnostics 验证：

- `cacheable_prefix_hash` 在普通相邻 turn 中稳定。
- 修改 current user input 不改变 `cacheable_prefix_hash`。
- 修改 runtime reminder / approval hint 不改变 `cacheable_prefix_hash`。
- tool schema 顺序和 schema hash 稳定；动态 tool exposure 必须显式改变 `tool_schema_hash`。
- compact 前后的 frozen/stable fragments hash 不变。
- pre-compact pruning 只改变 replay/compact diagnostics，不改变 stable prefix hash。
- Responses / Chat Completions / Anthropic 三个 formatter 都保持 stable-first ordering。
- provider usage 可用时，记录 `cached_tokens` / prompt token details；不可用时，内部 hash 仍可作为 regression oracle。

## Provider 约束

OpenAI prompt caching 基于前缀匹配。缓存命中要求 prompt 开头的内容完全一致。instructions、examples、tool schemas、重复上下文等静态内容应该放在最前面；当前用户输入、每轮状态等可变内容应该放在后面。工具定义和顺序也会影响可缓存性。缓存使用情况可以通过 `usage.prompt_tokens_details.cached_tokens` 等字段观测；OpenAI 文档也说明，prompt caching 需要约 1024 token 的最低门槛，才可能产生非零 cached tokens。

对 `mycli` 的含义：

- request 开头附近的一行动态内容，会从该行开始向后破坏缓存。
- 在末尾追加 volatile 内容是可以接受的，因为稳定前缀仍然完全一致。
- 稳定 tool schema 是可缓存表面的一部分。工具重排或每轮修改工具描述会降低 cache hit。
- 本地 `cache_class` 只是内部规划信号；只有最终 provider payload 也保留相同顺序时，它才真正有缓存意义。
- prefix-cache 策略必须同时用内部 shape hash 和 provider usage metrics 验证。

参考：OpenAI Prompt Caching guide，`https://platform.openai.com/docs/guides/prompt-caching`。

## 设计原则

### 稳定前缀优先

面向 provider 的内容必须按变化频率排序：

```text
stable base instructions
stable tool schema
stable workspace instructions
stable skill/tool catalog indexes
selected replay and rehydration context
selected memory, plan, and environment facts
current user request
ephemeral runtime reminders
ephemeral approval/tool-loop state
```

稳定前缀在第一个非 stable fragment 处结束。`mycli` 必须把这个边界视为 runtime contract，而不是尽力而为的格式偏好。

### 动态状态必须在边界之后

下列值不能进入 `base_instructions`、stable workspace sections、stable tool schemas 或 stable skill catalogs：

- session id、turn id、timestamp、elapsed time、token counters
- active mode state、current phase、retry count、subagent count
- pending approval status、current tool loop state、temporary reminders
- latest diagnostics、trace summaries、error counters、stream metrics
- current model response ids 或 provider continuation ids

这些值可能对模型有用，但它们应该位于稳定前缀之后的 `dynamic` 或 `ephemeral` section。如果它们只用于诊断，就保留在 trace metadata 中，不要渲染进模型 prompt。

### Append-Only 意味着前缀不可变

Append-only 只有在旧字节被完整保留时才有价值。如果 request assembly 会重写、重新编号、重新排序或总结旧 prompt 文本，那么即使底层事件日志是 append-only，也不足以保护 prefix cache。

`mycli` 应使用这条规则：

- Stable zone：一旦作为某个 session shape 发出，就不可变，除非底层静态输入确实发生变化。
- Dynamic zone：可以被重写或压缩，但不能被误标为 stable。
- Ephemeral zone：可以每轮变化，并且应该尽可能靠后。
- Trace/log stores：可以 append-only，但不等于 model-visible。

需要保护的对象是可缓存前缀，而不是整段 conversation。

## Request Shape Contract

`RequestShapeBuilder` 是 provider-visible ordering 的权威。`TurnContextAssembler` 和 `InstructionContractAssembler` 可以分类内容，但只有 `RequestShapeBuilder` 保留同一个 cache boundary 时，provider payload 才是正确的。

### Fragment 分类

`mycli` 应继续使用这些 cache classes：

| Cache class | Stability | 示例 | Provider 位置 |
| --- | --- | --- | --- |
| `static` | `STABLE` | base instructions、tool schema、workspace instructions、stable skill catalog index | 所有 replay/dynamic 内容之前 |
| `dynamic` | `REPLAY` | 经过筛选的 conversation replay、memory、plan、compaction rehydration、environment facts | stable prefix 之后、current user 之前；默认不全量携带 |
| `ephemeral` | `VOLATILE` | current user request、runtime reminders、approval/tool-loop hints | 尾部 |

只有 `RequestShape.fragments` 开头连续的 `STABLE` fragments 属于 `cacheable_prefix_fragment_ids()`。如果一个 `STABLE` fragment 出现在 replay 或 volatile 内容之后，应视为 shape bug，因为它已经无法贡献给 provider prefix cache。

### Provider Payload 顺序

每个协议 formatter 都必须保留相同的语义顺序，即使 wire format 不同：

- Responses API runtime items：stable system/developer/tool context 在前，replay/dynamic input 随后，current user 和 ephemeral sections 最后。
- Chat Completions messages：system 在前，stable context 随后，replay messages 随后，dynamic context 随后，current user 加允许的 current-turn ephemeral injection 最后。
- Transcript-only compatibility modes：避免把 dynamic sections 注入 synthetic stable system message，除非它们确实是 static。

如果某个 provider 需要特殊 transcript projection，该 projection 必须有测试证明：当 current user input 和 runtime reminders 变化时，`cacheable_prefix_hash` 保持稳定。

## Static 内容规则

### Base Instructions

`build_system_prompt()` 和 stable ReAct guidance 应该是确定性的。它们不能读取 session state、environment variables、runtime traces、current plans、current tool names、plugin diagnostics 或 timestamps。

允许：

- 长期行为和安全规则
- 固定 response 和 tool-use 约定
- 固定 provider-independent runtime contract

禁止：

- "Current session id is ..."
- "Active mode is ..."
- "You have N subagents"
- "Current date/time is ..."，除非产品有意让日期成为某次运行所有 turn 的 static prompt 一部分，并且接受缓存取舍

如果需要日期或环境事实，把它们渲染到后面的 section，并使用合适的 cache class。

### Workspace Instructions

Workspace instructions 只有在 loader 已经清洗并以 reference context 方式加 fence 后，才可以是 `static`。在同一个 workspace 中，它们应该跨 turn 保持稳定。

不要把 runtime state 追加到 workspace instructions。local plugin 或 mode 不得在 `AGENTS.md` 派生内容渲染进 stable prefix 前 patch 它。

推荐 metadata：

```text
source
selected_path
section_hash
cache_class=static
```

Diagnostics 应包含 hashes 和 lengths，而不是原始 workspace instruction 文本。

### Skill Catalog

Skill catalog 只有在它是确定性索引时，才可以是 `static`：

- 按 skill id 稳定排序
- 字段选择稳定
- 不包含 active/last-used state
- 不包含 timestamps 或 filesystem mtimes
- 不包含 per-turn relevance scores

大型 skill 正文应该只在需要时加载，并按变化行为分类。某个已选择 skill 的稳定 instructions 如果是确定性的，可以是 static；当前 activation state 和 runtime reminders 仍然是 ephemeral。

### Tool Schema

Tool schema 是 cache-sensitive surface 的一部分。`mycli` 应该：

- 按 stable id/name 规范化工具顺序
- 规范化参数顺序
- 保持 descriptions 确定
- 把 safety policy 留在 runtime enforcement 中，而不是写进每轮变化的 tool descriptions
- 避免在 tool descriptions 中暴露 provider-visible diagnostics

动态 tool exposure 是允许的，但必须是有意为之。当暴露的 tool set 变化时，`tool_schema_hash` 必须变化，diagnostics 必须让 cache impact 可见。

Plugin tools 应使用稳定 id，例如 `plugin:<plugin_id>:<tool_name>`，并且不能在 provider descriptions 中包含 load-time diagnostics 或本地绝对路径。

## Dynamic 内容规则

Dynamic 内容不是“每轮都带”。它只是表示：如果这类内容被选中进入本轮 prompt，它必须位于 stable prefix 之后。默认策略应是 deny-by-default：除非本轮任务需要、内容有界、且不会被 trace/state 替代，否则不要进入 provider-visible prompt。

选择 dynamic 内容时使用这条规则：

- 模型完成当前 turn 必须知道：可以进入 prompt。
- 只是诊断、审计、恢复、统计需要：只进 trace/state，不进 prompt。
- 内容很长或相关性弱：先摘要或不带。
- 内容每轮都会变化但模型并不需要：不带。

### Environment Context

Environment context 很容易被误分类。应该拆分它，而不是把它当作一个单一 block：

- Static workspace identity：只有模型需要定位 workspace 时，才使用稳定 workspace name/root label。
- Dynamic runtime environment：只有会改变模型当前决策时，才包含 current model/protocol/profile。
- Diagnostic-only metadata：session id、trace path、raw config paths、provider continuation ids。

Model-visible environment text 应该保持最小，默认不带。多数 environment facts 更适合保留在 trace metadata 或 doctor diagnostics 中。

### Conversation Replay

Conversation replay 天然接近 append，但它并不完全稳定：

- 新 turn 会追加 messages。
- Tool outputs 可能被 compact。
- Summaries 可能替换旧文本。
- Provider-specific transcript repair 可能过滤无效 tool messages。
- Provider-private reasoning state 可能只能在同 provider / same issuer 下 replay。

Replay 应保持在 stable prefix 之后。Compaction 必须被视为 dynamic rewrite，而不是 stable prefix update。

### Provider-Private Reasoning State

Codex Responses 的 `type=reasoning` / `encrypted_content`、Anthropic thinking signature、以及类似 provider 私有连续性字段，不属于 stable prompt 文本。它们应作为 canonical timeline 上的 provider state 持久化，并由对应 provider adapter 在 replay/dynamic 区处理。

规则：

- 不进入 `base_instructions`、workspace static instructions、stable skill catalog 或 tool schema。
- 不转换成普通 assistant content；可读 `summary` 可以单独作为 reasoning summary 记录，但 encrypted/signature 字段保持 opaque。
- Responses adapter 可以在 same issuer 下回放 `encrypted_content`，并在请求中显式使用 `include=["reasoning.encrypted_content"]`。
- Responses adapter 必须给 persisted reasoning item 记录 issuer，例如 `codex_backend`、`xai_responses`、`github_responses` 或 custom endpoint key。
- Provider/endpoint 改变时，adapter 必须丢弃 foreign issuer 的 encrypted reasoning，避免 `invalid_encrypted_content`。
- 如果 provider 返回 `invalid_encrypted_content`，runtime 应清掉 active history 中的 encrypted reasoning replay state，禁用本 session replay，然后无 encrypted reasoning 重试一次。
- Chat Completions adapter 必须剥离 Codex Responses 私有字段；Anthropic adapter 必须只发送 Anthropic 支持的 thinking/signature 形态。

缓存含义：

```text
stable prefix:
  frozen instructions + stable workspace/tool/catalog

dynamic replay:
  assistant messages
  tool results
  provider-private reasoning state, if same issuer and supported

tail / current turn:
  current user input
  ephemeral runtime hints
```

这类 opaque state 可以提升模型连续性，但不能作为 prefix-cache 稳定前缀的一部分来设计。它属于 append-only replay 表面；compact 或 provider 切换都可能改变它。

### Memory And Plan

Memory、retrieved context 和 active plans 默认不进入 prompt。它们只有在本轮任务需要时，才作为 `dynamic` 内容进入 stable workspace 和 tool content 之后。

Memory 应通过相关性筛选后再渲染，并作为 reference context 加 fence，与 conversation replay 去重。不要携带所有历史记忆、所有 session summaries 或与当前任务无关的偏好。

Plan 只有在存在 active plan 且模型需要遵循或更新计划时才进入 prompt。Plan state 应保持简洁，只带当前目标、active step、必要约束和有界 pending/completed 摘要；不要携带完整计划日志或 volatile execution counters，除非模型在当前 turn 需要它们。

### Compaction Rehydration

Compaction rehydration 是 dynamic，因为它会随 session 演进而变化。当 provider format 支持该 shape 时，它应该位于 replay 之后或与 replay 相邻，并在 current user request 之前。

不要把 rehydration summaries 放进 stable system prompt。Rehydration 是状态恢复机制，不是持久运行规则。

### Pre-Compact Pruning

Compact 前精简只允许发生在 `dynamic` replay 区。它的目标是降低 summary 成本和 overflow 风险，而不是修改可缓存前缀。

允许精简：

- 旧 text / structured text tool output。
- 旧重复 tool result。
- 旧的大型 tool_call arguments。
- 即将被 summary 覆盖的中间历史窗口。

禁止精简：

- `static` / `STABLE` fragments。
- frozen system instructions。
- stable workspace instructions。
- stable skill catalog。
- tool schema。
- current user request。
- 受保护 tail 中的当前工作材料。

Provider 统一策略：

```text
all providers:
  canonical timeline
  -> Hermes-style deterministic cheap pruning
  -> summary + rehydration + tail
  -> provider-specific projection
```

Responses adapter 可以保留并 replay provider_state 中的 Responses 原始 item shape，但 compact engine 本身仍处理 canonical timeline，不为 Responses 单独维护一套 compact 语义。`/responses/compact` 只能作为 future optimization / experiment；启用时必须证明不会破坏 canonical compact invariants。

因此，pre-compact pruning 之后必须重新计算 replay hash / compact boundary diagnostics，但 `cacheable_prefix_hash` 不应变化。若 pruning 导致 stable prefix hash 变化，应视为严重 bug。

## Ephemeral 内容规则

Ephemeral content 每轮都会变化，应该放在最后：

- current user request
- runtime reminders
- approval reminders
- current tool-loop hints
- failure recovery hints
- temporary mode overlay

对于 Chat Completions transcript projections，可以把 current-turn ephemeral context 追加到当前 user message。这会在协议允许范围内尽量保留前面的 stable 和 replay prefix。

不要仅仅因为实现方便，就把 ephemeral content 追加到 system message。那会让每个 turn 都像一个新的 prefix。

## Plugin And Extension Policy

Plugins 和 OMX-like modes 这类编排层是缓存风险，因为它们倾向于向 prompts 注入状态。Host 必须拥有 cache boundary，并提供要求显式声明变化行为的 plugin extension points。

Plugin-provided prompt content 应注册为以下之一：

- `static`：确定性的 capability guidance 或 stable catalog entry。
- `dynamic`：retrieved plugin context、enabled-resource summaries、active command state。
- `ephemeral`：current-turn hints、approval messages、error recovery notes。

Host 应在以下情况拒绝或降级 plugin content：

- 标记为 `static` 的内容包含 timestamps、session ids、absolute temp paths、active counters 或 trace-derived values
- plugin ids 或 entries 没有确定性排序
- static content 在相邻 turn 之间变化，但没有底层 manifest 或 configuration change

Plugin diagnostics 应属于 logs、trace、doctor 或 provider-free commands，除非模型确实需要当前 turn 的有界摘要。

## prompt_cache_key Policy

OpenAI 支持 `prompt_cache_key`，作为与 prefix hash 结合使用的 routing hint。`mycli` 应把它视为优化，而不是事实来源。

推荐 key 粒度：

```text
provider
model family or exact model
workspace static context hash
tool schema hash
stable skill/catalog hash
```

避免 key 包含：

- current user text
- session id
- turn id
- timestamps
- dynamic memory hash
- current active plan text

这个 key 应把共享稳定前缀的 requests 分组，同时避免把太多无关 shape 强行放进同一个 routing bucket。如果 provider docs 或 rate behavior 发生变化，应在配置后面重新评估该策略。

## Diagnostics And Guardrails

### Required Shape Metrics

每个 model request trace 都应包含：

- `system_hash`
- `tool_schema_hash`
- `tool_order_hash`
- `replay_hash`
- `volatile_hash`
- `cacheable_prefix_fragment_ids`
- `cacheable_prefix_hash`
- `estimated_cacheable_prefix_chars`
- provider message/runtime item hashes
- 包含 source、cache class 和 section hash 的 fragment metadata summary

这些值已经存在于当前 request-shape domain model 中，并且应该继续作为稳定 contract。

### Required Provider Usage Metrics

当 provider responses 包含 usage details 时，`mycli` 应记录有界 cache metrics：

- 来自 `prompt_tokens_details` 或 `input_tokens_details` 的 `cached_tokens`
- total prompt/input tokens
- 可计算时的 cache hit ratio
- model/provider/protocol
- request shape hash identifiers

Raw request payloads、user text、tool output、memory values、headers 和 secrets 不能进入 diagnostics。

### Stable Mutation Warnings

运行时应在同一 session 中比较当前 request shape 和上一轮 request shape。出现以下情况时，发出 warning-level diagnostic：

- `cacheable_prefix_hash` 变化，但没有 static input 变化
- `tool_schema_hash` 在普通 user turns 之间变化
- 某个 `static` fragment 包含看起来动态的 metadata
- `estimated_cacheable_prefix_chars` 显著下降
- provider 对重复长前缀报告 `cached_tokens=0`

warning 应识别 fragment ids 和 hashes，而不是原始内容。

### Doctor Summary

`mycli doctor` 应保持 provider-free 和 read-only。它可以基于 traces 报告有界 cache-shape summaries：

- max estimated cacheable prefix tokens
- distinct `cacheable_prefix_hash` 数量
- most common cache-boundary fragment id sequence
- tool schema changes 的 turn 数量
- 可用时 provider cached tokens 的 turn 数量

Doctor 不能重建 prompts，也不能打印 model-visible content。

## Testing Requirements

### Unit Tests

新增或保留测试以证明：

- 改变 `current_user_request` 不会改变 `cacheable_prefix_hash`。
- 改变 runtime reminders 不会改变 `cacheable_prefix_hash`。
- 改变 session id、turn id 或 diagnostics metadata 不会改变 provider-visible stable fragments。
- 改变 workspace instructions 会改变 `cacheable_prefix_hash`。
- 改变 tool parameters 会改变 `tool_schema_hash`。
- caller input 中的 tool order 变化不会改变 `tool_order_hash`。
- Skill catalog ordering 是确定性的。
- Plugin static entries 已排序且稳定。
- Ephemeral sections 排在 current user intent 之后。
- 没有 stable fragment 出现在 non-stable fragment 之后。

### Integration Tests

新增 provider-free integration tests：

- `TurnContextAssembler -> InstructionContractAssembler -> RequestShapeBuilder` 保留 cache class metadata。
- Chat Completions formatting 保留 stable-first 顺序。
- Responses formatting 保留 stable-first runtime item 顺序。
- Transcript-only compatibility paths 把 current-turn ephemeral context 追加到当前 user message，而不是 system message。
- Cache-shape diagnostics 在比较相邻 turns 时不泄露 raw prompt。

### Smoke/Evaluation

维护一个 smoke：运行重复相似 turns，并报告：

- stable prefix hash stability
- tool schema hash stability
- provider `cached_tokens` when available
- provider usage 可用时的 latency deltas

该 smoke 应允许通过验证内部 hashes 以 provider-free 方式通过；当启用真实 API usage 时，再用 provider metrics 丰富报告。

## Implementation Roadmap

当前阶段不实现完整记忆系统、background maintenance、multimodal tool result envelope。路线图中的 memory/plan 只表示 request shape 对外部召回内容的承载能力；multimodal 相关处理延后到独立阶段。

### Phase 1: Document And Lock Current Shape

- 保持 `RequestShapeBuilder` 作为 provider-visible ordering authority。
- 为 current user 和 runtime reminder changes 添加 regression tests。
- 添加 invariant test：所有 `STABLE` fragments 必须在开头连续。
- 扩展 diagnostics，用于标记相邻 turns 之间的 stable prefix mutation。

### Phase 2: Split Environment Context

- 除非模型需要，否则把 session id/model/protocol/path details 移出 model-visible text。
- 如有需要，引入单独的 static workspace identity。
- 把 diagnostic-only environment values 保留在 trace metadata 中。

### Phase 3: Plugin Prompt Contributions

- 添加显式 plugin prompt contribution contract，并包含 `cache_class`。
- 对 plugin prompt entries 做确定性排序。
- 拒绝或降级可疑 static plugin content。
- 添加 plugin static/dynamic/ephemeral ordering tests。

### Phase 4: Provider Optimization

- 为 OpenAI-compatible providers 添加可选 `prompt_cache_key` 生成。
- 使 key 可配置、可观测。
- 在 smoke reports 中对比 provider `cached_tokens` 和 internal prefix hashes。

### Phase 5: Replay And Adapter Hardening

- Responses adapter 持久化并 replay same-issuer `codex_reasoning_items`。
- Responses adapter 持久化并 replay same-shape `codex_message_items`，包括 provider 返回的 `id` / `phase` / `status`。
- Chat Completions adapter 剥离 Responses 私有字段、Anthropic 私有字段、内部 `_` 标记和 provider-only tool metadata。
- fallback tool call id / response item id 使用 deterministic hash，不使用随机 UUID。
- 所有 provider 共用 canonical compact engine，并在 compact 前执行 deterministic cheap pruning：旧 text tool output 摘要、重复 tool result 去重、大型 tool_call arguments JSON 内截断。
- `/responses/compact` 仅作为 future optimization / experiment；默认不为 Responses 维护单独 compact 路径。
- compact 失败时默认 abort，不静默删除历史；fallback marker 必须带 failure metadata。
- provider error 进入统一 `ErrorClassifier -> RecoveryPolicy`，不要在 adapter 中散落字符串匹配。
- debug dump / compact summary / tool result 走统一 redaction boundary；memory extraction 的 redaction boundary 留到记忆系统阶段实现。

### Deferred: Memory And Background Maintenance

- 完整 memory provider lifecycle、background prefetch、memory extraction、session search 索引暂不实现。
- 后台 skill curator / background maintenance 暂不实现。
- 当前阶段只保证：如果外部模块提供 selected memory/plan context，request shape 能把它作为 `dynamic` 或 persistent timeline item 表达。

### Deferred: Multimodal Tool Results

- multimodal tool result envelope、图片/截图 provider projection、历史图片 payload placeholder 暂不实现。
- 当前阶段只处理 text / structured text tool result 的 replay、pruning 和 redaction。

## Review Checklist

在修改 request/context/tool/plugin prompt assembly 之前，reviewer 应该问：

- 这是否在 stable prefix boundary 之前添加了动态值？
- 这是否改变 tool schema 文本或顺序？
- 这是否把依赖 runtime state 的内容标成 static？
- 这是否以 provider-visible 方式重写了旧 append-only content？
- 这是否在每一层都保留 cache class metadata？
- 这是否添加了 diagnostics，并且没有泄露 raw prompts 或 secrets？
- 是否有测试证明预期的 cache boundary 行为？
- fallback ids 是否 deterministic，避免随机值进入 provider-visible replay？
- provider-private state 是否只在支持它的 adapter 中回放？
- Chat/Anthropic/Responses adapter 是否都剥离了自己不支持的字段？
- compact 是否保护 last user message 和 tool_call/tool_result group？
- pre-compact pruning 是否只作用在 dynamic replay 区，并保持 stable prefix hash 不变？
- Responses provider_state 是否在 canonical compact 中保持专用通道，而不是被压平成普通文本？
- compact 失败时是否不会静默丢失历史？
- error recovery 是否通过统一分类触发，而不是在 adapter 内即兴处理？

如果答案不清楚，就把内容分类为 `dynamic` 或 `ephemeral`，并放在 stable prefix 之后，直到有证据证明它可以安全提升。
