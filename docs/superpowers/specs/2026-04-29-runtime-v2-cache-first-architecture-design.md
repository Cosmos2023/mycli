# Runtime V2 缓存优先架构设计

日期：2026-04-29

## 摘要

Runtime v2 围绕稳定请求形状、provider 中立 replay、检索式记忆，以及确定性的工具 schema 组装来重新设计 agent runtime。当前最直接的压力来自 DeepSeek 缓存成本：真实日志显示，复杂任务和受控多轮会话的缓存命中率大约只有 30-40%；而针对 `deepseek-v4-flash` 的 AgentScope spike 显示，稳定前缀请求在 warmup 后可以达到约 96% 的 prompt cache hit。

问题是架构性的，不是单个 DeepSeek provider bug。当前 runtime 会让动态上下文、工具暴露状态、记忆摘要和 provider replay 细节漂移到请求前部。Runtime v2 将缓存稳定性提升为所有 provider 的一等架构不变量，包括 DeepSeek、Qwen、OpenAI 和 Anthropic。

Implementation starts with Phase 1, which adds provider-neutral `RequestShape` domain types and cache shape diagnostics without changing runtime behavior. Later phases migrate tools, memory, provider formatting, and runtime assembly onto those contracts.

Phase 2 replaces prompt-visible tool hierarchy with an equal `ToolSet`, stabilizes model-visible tool schema ordering, and keeps execution safety outside schema visibility. It preserves compatibility with existing runtime containers while removing direct/deferred/recommended language from agent-facing context.

Phase 3 adds a provider-neutral `RequestShapeBuilder` and emits cache-first request shape diagnostics from live runtime turns. Existing provider payload formatting remains unchanged in this phase; the new shape is a verified migration target for later formatter replacement.

Phase 4a makes legacy chat-style `ModelMessage` payloads come from `RequestShape.provider_messages`, so chat-completions providers start receiving cache-first ordering while structured block replay remains on the existing RuntimeItem path.

Phase 4b adds block-aware runtime item shapes and makes structured `RuntimeItem` payloads come from `RequestShape`, preserving tool-call/tool-result replay while applying the same cache-first ordering to Responses/Anthropic-style adapters.

Phase 5a splits volatile context diagnostics into section-level request fragments such as `volatile:runtime_policy`, `volatile:plan`, and `retrieved_memory`. Provider payload text is unchanged in this phase; the split exists to identify which volatile slice breaks cache reuse first.

Phase 5b keeps replay transcript as the authority for recent conversation and tool evidence by removing replay duplicates from retrieved memory and volatile conversation context.

Phase 5c compacts volatile runtime state by rendering runtime policy in deterministic key order and plan state as counts plus current/next actions, avoiding completed plan text churn after the current user intent.

Phase 5d removes remaining high-impact drift by keeping tool names authoritative in native tool schema instead of developer text, excluding reasoning-only content from summaries and textual replay, stopping automatic session-summary memory injection, and sorting dynamic tool context deterministically.

## 证据

DeepSeek 日志分析发现了这些缓存杀手：

- `messages[1]` 是一条很大的动态 contextual user message，通常也是相邻请求之间第一个发生变化的 message。
- 当 `Direct tools` 和 `Deferred tools` 变化时，`messages[0]` 也会变化，这会从 system prompt 开始破坏缓存。
- 即使工具集合相同，只要 direct/deferred 归属变化，工具 schema 顺序也会变化。
- Session memory 会注入最近 assistant 摘要，并与 conversation context 重复。
- Tool evidence 同时出现在 contextual summaries 和 transcript replay 中。
- Provider reasoning/thinking replay 与通用 context、memory 关注点混在一起。

AgentScope spike：

- 稳定前缀的第二次调用：prompt `2939`，cache hit `2816`，miss `123`，ratio `0.9581`。
- 动态 context 放在稳定内容之前的第二次调用：prompt `3190`，cache hit `1152`，miss `2038`，ratio `0.3611`。
- 在相同 messages 下反转工具 schema 顺序，会让命中率从约 `0.9598` 下降到 `0.3926`。

这说明 SDK 选择不如 request shape 重要。AgentScope 真正值得借鉴的是边界设计：model、formatter 和 message blocks 是分离的。Runtime v2 应该吸收这种边界思想，但不需要整体替换成 AgentScope。

## 目标

- 在同一个 session 内保持 stable system content 不变。
- 除非实际 ToolSet 变化，否则保持工具 schema 顺序和工具 schema hash 稳定。
- 将 volatile runtime context 移到稳定请求前缀之后。
- 将 memory 改为检索式、有预算、可去重。
- 让 tool evidence 只保留在一个权威通道中。
- 避免 provider reasoning/thinking replay 进入 memory 和 contextual summaries。
- 让 provider adapters 成为协议转换器，而不是 prompt 设计器。
- 增加 diagnostics，解释哪个 request fragment 破坏了缓存复用。
- 在 DeepSeek、Qwen、OpenAI 和 Anthropic 上保留工具正确性、审批行为和 provider replay 需求。

## 非目标

- 不把全部 runtime 代码替换成 AgentScope。
- 不把 DeepSeek-only hack 做成默认架构。
- 不只依赖 prompt 文本来保证安全或工具权限。
- 不承诺每个任务都达到 99% 命中率。目标是稳定前缀行为和可测量提升；用户请求、工具结果和新 evidence 仍然会产生合理的 cache miss。

## 架构

Runtime v2 将当前 runtime 拆成显式分层：

1. `TurnRuntime`
   - 负责 turn loop、工具执行、审批、suspension/resume 和 activity events。
   - 不直接构造 provider payload。

2. `RequestShapeBuilder`
   - 将 runtime state 转换成 provider-neutral request shape。
   - 应用 cache policy、context ordering、memory selection 和 ToolSet references。

3. `ToolSet` 和 `ToolSafetyGate`
   - `ToolSet` 是稳定、平等、model-visible 的工具集合。
   - 所有工具在 agent 系统中不再有 direct/deferred/recommended 等等级之分。
   - `ToolSafetyGate` 只在执行时处理审批、拒绝和外部安全约束，不影响工具 schema 可见性或顺序。

4. `MemoryRetriever`
   - 根据当前 intent 选择相关 memory records。
   - 对 transcript 和 summaries 去重。
   - 执行预算限制，并排除 reasoning/thinking。

5. `ProviderFormatter`
   - 将 `RequestShape` 转成 provider payload。
   - 处理 provider-specific replay metadata，例如 DeepSeek `reasoning_content`、Anthropic thinking 和 Responses API items。

6. `CacheShapeDiagnostics`
   - 记录 shape hashes、fragment sizes、first-diff index，以及 provider usage 中的 cache hit/miss 数据。

## 请求形状

Runtime v2 使用 provider-neutral request shape：

```text
Stable System
Stable Tool Schema
Provider Replay Transcript
Current User Intent
Volatile Runtime Context
```

### Stable System

Stable system 只包含长期稳定的运行规则：

- role 和 safety baseline
- 稳定抽象层级上的 tool-use contract
- provider-neutral behavior rules
- 只有在 workspace instructions 是 stable baseline fragments 时才进入 system

它不得包含：

- direct/deferred tool lists
- runtime policy state
- current user request
- session id
- model name
- protocol
- recent conversation
- memory records
- tool evidence

### Stable Tool Schema

Tool schema 从 `ToolSet` 按确定性顺序序列化。推荐顺序是静态 registry 顺序，并配合持久化的 toolset version hash。如果 registry 顺序还不够稳定，则按 route key 排序。

Dynamic tools 使用稳定 route key 追加在 static tools 之后。Dynamic tool lifecycle 变化可以合理地改变 tool schema hash；但 prompt 策略、用户话术、执行审批状态不能改变工具 schema hash。

### Provider Replay Transcript

Replay transcript 是 provider-required state 的权威历史通道：

- user messages
- 必须 replay 的 assistant text
- assistant tool calls
- 按 call id 配对的 tool results
- 有效 replay 所需的 provider reasoning metadata

Replay transcript 不应该携带会与后续 volatile context 重复的额外 contextual summaries。

### Current User Intent

当前用户请求只表示一次。Runtime v2 必须避免它同时出现在 contextual fragments 和实际 user message 中。

### Volatile Runtime Context

Volatile context 放在最后，并保持简短。它可以包含：

- compact runtime reminders
- active plan status
- selected memory snippets
- evidence index summaries
- tool safety notes

它不得包含 transcript 中已经存在的完整 tool evidence。

## Typed Fragments

`RequestShapeBuilder` 使用 typed fragments，而不是原始拼接字符串：

- `StableFragment`：stable system 或 baseline content。
- `ReplayFragment`：provider-required transcript 和 metadata。
- `IntentFragment`：当前请求。
- `VolatileFragment`：简短 runtime policy、plan 或 reminder content。
- `RetrievedMemoryFragment`：只包含被选中的 memory。
- `EvidenceIndexFragment`：紧凑 tool result index。
- `ToolSafetyFragment`：当前执行安全约束，后置渲染；它不表达工具等级。

每个 fragment 携带：

- `id`
- `kind`
- `content`
- `stability`：`stable`、`replay` 或 `volatile`
- `dedupe_key`
- `budget_weight`
- `provider_visibility`
- diagnostic hash

## Deterministic Replay Contract

Runtime v2 必须把 replay transcript 视为不可变事件日志。凡是用户已经输入、模型已经返回、工具已经调用或 provider 已经要求 replay 的内容，后续进入 prompt 时都必须来自持久化原始记录，而不是由 context assembler、memory summary 或 runtime policy 重新改写一版。

固定性要求：

- `system prompt`：session 内固定，hash 不变。
- `tools` 描述与顺序：固定，除非真实 `ToolSet` 变更。
- 用户 query：当前 turn 内固定；历史 query replay 时逐字保留。
- LLM thinking/reasoning：生成前不可控，但 provider 返回后必须作为 replay metadata 原样保存并逐字回放。
- assistant 回复话术和最终回复：生成前不可控，但一旦进入历史，就不能被 summary 改写后替代 replay。
- tool call：`call_id`、tool name、arguments 和顺序固定 replay。
- tool result：与 call id 配对，内容和顺序固定 replay。

Summary、memory 和 evidence index 只能作为后置 volatile context 的补充索引，不能替代权威 replay transcript。语义相同但话术不同也会破坏缓存，因此 Runtime v2 不允许用重新生成的自然语言摘要替换已经发生过的原始 transcript。

## Memory V2

Memory 从默认注入改为检索式注入。

规则：

- Session summaries 会被存储，但不会自动注入。
- 最近 assistant responses 默认不会作为 memory 复制回 prompt。
- Memory 必须根据当前 user intent 的相关性选择。
- Memory 会对 replay transcript、conversation summary 和 selected volatile fragments 去重。
- Memory 有严格预算。
- Reasoning/thinking blocks 永远不会存入 memory。
- Tool evidence 不会作为 memory 存储，除非它被明确提炼成稳定事实。

Memory 输出应该是简短事实，而不是很长的历史回答。

## Tool System V2

Runtime v2 将工具系统改成平等工具集，并把执行安全从工具可见性中分离出来。

### ToolSet

ToolSet 拥有稳定工具定义：

- name
- description
- parameter schema
- route key
- source
- toolset version hash

它按确定性顺序生成 model-visible schema。

所有工具在 model-visible schema 中地位平等。Runtime v2 不再向 agent 暴露 direct、deferred、recommended 等等级，也不再根据当前任务把某些工具排到前面。

### ToolSafetyGate

ToolSafetyGate 拥有执行时安全状态：

- tools requiring approval
- user-forbidden tools
- externally denied tools
- risk-derived constraints
- session command allowances

Safety gate 在执行时强制生效。它可以被摘要到后置 volatile context 中，但不得改变工具 schema、工具顺序或制造工具等级。

否定指令必须保守解析。例如，“do not call git_diff or run_shell” 必须在执行安全层阻止这些工具，不能因为出现了 `git` 或 `shell` 这些词就改变工具集或提升它们。

### ToolExecutor

ToolExecutor 在执行前根据 `ToolSafetyGate` 校验每一个模型工具调用。Prompt guidance 只是建议；execution safety 才是权威。

## Reasoning and Thinking Replay

Provider thinking 只属于 replay metadata。

规则：

- DeepSeek `reasoning_content` 在需要时保留到 assistant replay messages 上。
- Anthropic thinking blocks 通过 provider formatter replay 保留。
- OpenAI/Qwen Responses items 归一化为 replay blocks。
- Thinking content 不写入 memory。
- Thinking content 不渲染进 volatile context。
- Thinking content 不总结进 conversation summaries。

Provider adapters 声明自己的 replay requirements，runtime 不再猜测。

## Provider Formatter Boundary

Provider formatters 接受 `RequestShape` 并返回 provider payload：

- 面向 DeepSeek 和兼容 provider 的 Chat Completions payload。
- 面向 OpenAI/Qwen-compatible Responses providers 的 Responses payload。
- 面向 Anthropic 的 Anthropic Messages payload。

Formatters 可以适配 roles、在 provider 协议要求时合并 system messages，并编码 replay metadata。它们不得决定 memory selection、tool safety 或 context ordering。

## Cache Policy

所有 provider 默认使用 cache-first policy。Provider 可以覆盖细节：

- DeepSeek：严格 stable system、严格 stable tools、reasoning replay metadata、激进 volatile compaction。
- Qwen Responses：stable instructions 和 tools、Responses item replay，不带 DeepSeek-specific reasoning fields。
- OpenAI Responses：stable instructions 和 tools、Responses item replay、provider-native tool item handling。
- Anthropic：stable system/messages split，并按 Anthropic 协议 replay thinking。

Policy knobs：

- `stable_system_required`
- `stable_tool_schema_required`
- `volatile_context_position`
- `memory_injection_mode`
- `tool_safety_render_mode`
- `reasoning_replay_mode`
- `max_volatile_chars`
- `diagnostics_enabled`

## Diagnostics

每个模型请求都应该发出一个 shape diagnostic event：

- provider
- protocol
- model
- system hash
- tool schema hash
- tool order hash
- replay hash
- intent hash
- volatile hash
- per-fragment character lengths
- per-message character lengths
- 与前一个请求相比第一个发生变化的 fragment
- 与前一个请求相比第一个发生变化的 provider message index
- prompt tokens
- cache hit tokens
- cache miss tokens
- cache hit ratio

Diagnostics 必须 redact secrets，且不得记录 API keys。

## Migration Plan

1. 添加 request shape domain types 和 diagnostics，不改变现有行为。
2. 通过 `RequestShapeBuilder` 复现当前 prompt 输出，并用 snapshot-style unit tests 锁住。
3. 引入 `ToolSet`、`ToolSafetyGate` 和 stable schema serialization。
4. 将 provider payload construction 移到 formatter boundaries 后面。
5. 用 retrieval、budget 和 dedupe 替换 automatic memory injection。
6. 将 tool evidence duplication 改为 single-channel replay 加 compact evidence index。
7. 为所有 provider 启用 cache-first ordering。
8. 运行 provider-specific regression tests 和真实 DeepSeek smoke tests。

## Testing

Unit tests：

- 当只有 tool safety state 变化时，system content 在多 turn 中保持稳定。
- 所有工具作为平等工具集渲染；不存在 direct/deferred/recommended 等等级导致的 schema 变化。
- 否定工具指令不会提升 forbidden tools。
- memory retrieval 排除重复的 recent assistant content。
- reasoning/thinking 不进入 memory 或 volatile context。
- 当 transcript 已经包含 evidence 时，evidence index 不包含完整重复 evidence。
- provider formatters 保留必要 replay metadata。

Integration tests：

- DeepSeek chat-completions tool call 和 reasoning replay。
- Qwen Responses multi-turn tool call。
- OpenAI Responses replay 和 tool result continuation。
- Anthropic thinking/tool replay。
- approval 和 denied tool execution 仍然工作。

Manual smoke：

- DeepSeek complex repository task 加 follow-up no-tool questions。
- 与当前 30-40% baseline 对比 cache hit ratio。
- 确认 warmup 后 system hash 和 tool schema hash 保持稳定。

## Risks

- 激进减少 memory 可能让某些 follow-up answers 上下文不够丰富。缓解方式：按当前 intent 检索，并显式 replay transcript。
- Provider replay requirements 不同，如果隐藏在 formatter 细节里可能回归。缓解方式：provider-specific replay tests。
- Stable tool schema 可能暴露当前 safety gate 会拒绝执行的工具。缓解方式：清晰的执行错误和后置 volatile safety note。
- Cache hit rate 仍然取决于 workload。新 evidence 和 tool results 仍会产生 miss；diagnostics 会识别合理 miss。

## Acceptance Criteria

- Runtime v2 design boundaries 已实现，且 `agent_runtime` 中没有 provider-specific prompt hacks。
- DeepSeek multi-turn requests 在同一个 session 内保持 stable system hash。
- 除非实际 ToolSet 变化，否则 tool schema order hash 保持稳定。
- 工具系统不存在 direct/deferred/recommended 等等级；所有 model-visible tools 平等且确定性排序。
- Dynamic tool lifecycle changes 是确定性的、可诊断的。
- Memory injection 是检索式且可去重的。
- Tool evidence 不在 contextual user blocks 和 transcript replay 之间重复。
- Provider reasoning/thinking replay 保持正确，并从 memory/context summaries 中排除。
- Deterministic replay contract 保证历史用户输入、assistant 输出、thinking metadata、tool call 和 tool result 不被 summary/memory/context 重新改写后替代。
- Cache diagnostics 能识别导致 request drift 的第一个 fragment。
- DeepSeek real smoke 相比当前 30-40% 的 complex-task baseline 有显著 cache hit improvement。
