# mycli 上下文组装参考

本文档定义 `mycli` 每个用户 turn 内的上下文语义、持久化边界、compact 规则和 provider adapter contract。它回答的是：

```text
哪些内容应该成为 agent 后续上下文？
哪些内容只服务一次 API request？
不同 provider 如何从同一条 canonical timeline 投影出 wire payload？
compact 后如何复水并继续工作？
```

Prefix cache 的 byte-level request shape、stable prefix hash、fragment ordering 细节放在 [prefix-cache-request-shape-design.md](./prefix-cache-request-shape-design.md)。本文只定义语义 contract；缓存文档定义 provider-visible ordering contract。

## Goal

把 `mycli` 打造成一个 **高 prefix-cache 命中率、跨 LLM provider 兼容、可长期工作的 coding agent**。

这个目标同时包含三件事：

```text
1. 高缓存命中率:
   request 前缀稳定、工具 schema 稳定、动态内容靠后、compact 不污染 frozen/stable 区

2. 跨 provider 兼容:
   内部使用统一 canonical timeline
   外部适配 OpenAI Responses / OpenAI-compatible Chat Completions / Anthropic Messages
   provider 私有字段通过 adapter 隔离，不互相污染

3. Coding agent 连续性:
   agent-visible context 可持久化、可 replay、可 compact、可复水
   tool call/result、planning context、workspace rules、provider state 都有明确生命周期
```

### 成功标准

`mycli` 的上下文系统只有同时满足以下标准，才算达成这个目标：

- 同一 session 中，base instructions、workspace rules、stable tool schema、stable skill catalog 的 hash 在普通 turn 之间保持不变。
- current user input、runtime reminder、approval/tool-loop state 改变时，不改变 stable prefix hash。
- OpenAI Responses lane 能 replay canonical timeline，并保留 same-issuer encrypted reasoning / Responses message item state。
- OpenAI-compatible Chat Completions lane 能从同一 timeline 降级到 `messages[]`，同时显式剥离 Responses / Anthropic 私有字段。
- Anthropic lane 能从同一 timeline 投影到 Messages API，并只在 wire copy 上添加 `cache_control`。
- compact 后 frozen system 不变，active context 由 `summary + rehydration + tail` 继续，last user 和 tool_call/tool_result group 不被切断。
- compact 前的 cheap pruning 只作用于 dynamic replay 区，不改变 stable prefix hash。
- provider 错误恢复有统一分类，例如 `invalid_encrypted_content`、`context_overflow`、unsupported field，而不是在 adapter 中即兴处理。
- diagnostics 能同时报告 internal prefix hashes 和 provider usage cache metrics；没有真实 provider metrics 时也能用内部 hash 做 regression。

### 非目标

当前目标不是：

- 为每个 provider 写一套互不相干的上下文系统。
- 为了缓存命中率牺牲 agent 必须知道的上下文。
- 把所有 memory、plan、environment facts 每轮无差别塞进 prompt。
- 把 provider-private reasoning、thinking signature 或 cache hint 压平成普通文本。
- 当前阶段实现完整记忆系统、后台维护系统或 multimodal tool result envelope。

当前设计定稿采用三条 provider lane：

- **Codex / OpenAI Responses-style 协议**：学习 Codex。凡是希望 agent 后续持续知道的内容，都作为 model-visible context item 进入持久 conversation timeline，并在后续 turn replay。hook / plugin additional context、memory recall、plan recall、workspace/context update 都不默认当作一次性 user prompt 拼接。
- **OpenAI-compatible Chat Completions 协议**：内部仍使用同一条 canonical timeline，但发送层必须降级成 `messages[]`。它不是 Codex/Responses：没有原生 Responses item timeline，也没有标准 `reasoning.encrypted_content` replay。
- **Anthropic Messages 协议**：学习 Hermes。内部仍保持 `mycli` canonical timeline，但 Anthropic adapter 在发送层做 Messages API 映射，并在 API payload copy 上追加 `cache_control` breakpoints。`cache_control` 不写回 transcript。

核心目标不是最小化上下文，而是让 agent 的工作状态可 replay、可 compact、可 debug，同时用 provider adapter 保护各自的缓存机制。

---

## 核心不变量

以下规则优先于各 provider 的具体格式：

1. **Canonical timeline 是事实来源**：provider wire payload 只是从 timeline 投影出来的请求形状。
2. **agent-visible context 默认持久化**：如果某段内容影响后续工作，默认进入 durable timeline；除非明确标为 `api_only`。
3. **Provider 私有状态不混入普通文本**：Codex encrypted reasoning、Responses message item、Anthropic thinking signature 等进入 `provider_state`，由对应 adapter 决定是否回放。
4. **Wire adapter 必须降级而不是污染**：Chat Completions、Anthropic、Responses 不能互相泄漏不支持的字段。
5. **Compact 是 rewrite 边界**：compact 只替换 history 区，frozen system 不变；compact 后通过 `summary + rehydration + tail` 继续。
6. **临时 cache hint 不持久化**：例如 Anthropic `cache_control` 是 wire-only；OpenAI `prompt_cache_key` 是 request option。
7. **错误恢复有结构化路径**：例如 `invalid_encrypted_content` 触发禁用 encrypted reasoning replay 并重试，而不是污染后续 timeline。

---

## 当前阶段范围

本阶段聚焦 request/context assembly、provider adapter、prefix-cache shape、compact/replay 和错误恢复。以下能力先不实现，只保留未来扩展的语义接口：

```text
暂不实现:
  完整记忆系统
  background maintenance / skill curator / 后台整理任务
  multimodal tool result envelope

保留语义:
  memory recall / plan recall 如果由外部或后续模块提供，仍按 canonical timeline 规则表达
  compact lifecycle 预留 before_compact / after_compact hook
  tool result 暂按 text / structured text 处理
```

因此，文档中出现的 `memory recall`、`memory provider`、`multimodal` 等术语应理解为未来兼容点或 adapter 能力边界，不属于当前阶段必须交付的功能。

---

## 一、Turn 定义

`mycli` 的 turn 是一次用户触发的任务执行单元，不等于一次 request/response。

```text
turn_abc:
  user input
  request #1
  assistant tool_call
  tool result
  request #2
  assistant final / more tool calls / approval / failure
```

同一个用户 turn 内可能发生多次 model request。所有由模型真实产生、工具真实返回、runtime 决定要持久化的上下文，进入同一条 append-only timeline。

### 持久化边界

```text
request-scoped:
  只服务一次 API 调用，例如 retry warning、transport hint

turn-scoped:
  当前用户 turn 内可跨 continuation request 使用，例如 compact rehydration

session-scoped:
  存在 session state / memory / plan store，但是否进入 prompt 每轮重新决定

transcript-scoped:
  进入 durable conversation timeline，后续 turn replay
```

本设计中，**Codex/Responses-style 默认把 agent-visible context promotion 到 transcript-scoped**。Chat Completions 和 Anthropic 也 replay 同一份 canonical timeline，只是在发送层做能力降级。除非明确标注为 `api_only`，agent-visible context 都应进入 durable timeline。

---

## 二、Canonical Timeline

`mycli` 内部不直接使用某个 provider 的 wire format，而是维护一条 canonical item timeline。

```text
CanonicalItem:
  role: system | developer | user | assistant | tool | reasoning | summary
  content: ...
  source: user | agent | tool | hook | plugin | memory | plan | workspace | env | compact
  durability: persistent | api_only
  cache_class: frozen | stable | append_only | tail | no_cache
  metadata: dict
```

默认规则：

| 内容 | role / kind | durability | cache_class | 说明 |
| --- | --- | --- | --- | --- |
| base system prompt | system / instructions | persistent | frozen | 产品身份、固定安全边界、工具使用原则 |
| workspace rules | user 或 developer context | persistent | stable | AGENTS.md、项目规则、编码规范 |
| permission / mode / policy | developer | persistent | append_only | 参考 Codex 的 context update |
| skill catalog metadata | developer | persistent | stable | 只放 skill 名称、说明、触发信息 |
| invoked skill body | tool result 或 developer context | persistent | append_only | 如果模型使用了 skill，就成为可 replay context |
| user input | user | persistent | append_only | 用户真实输入 |
| assistant output | assistant | persistent | append_only | 模型真实输出 |
| tool call / tool result | assistant/tool | persistent | append_only | 工具轨迹 |
| reasoning encrypted state | reasoning | persistent | append_only | OpenAI Responses 可 replay 的 opaque reasoning state |
| hook/plugin additional context | developer | persistent | append_only | Codex/Responses-style 默认持久化，其他 provider 从 canonical timeline 降级发送 |
| memory recall | developer | persistent | append_only | 被选中的 recall 成为 agent 后续上下文 |
| plan recall / active step | developer | persistent | append_only | 进入 timeline，避免下轮丢失 |
| compact summary | summary / assistant | persistent | append_only | 取代被裁剪历史 |
| compact rehydration | developer 或 user context | turn-scoped 或 persistent | tail | compact 后当前 turn 必须复水 |
| trace id / request id | none | api_only | no_cache | 只进 trace，不进模型上下文 |

### Provider 私有 Reasoning State

`mycli` 需要区分“可读 reasoning 摘要”和“provider 私有 reasoning 状态”。

```text
readable reasoning summary:
  可以用于 UI / trace / compact reference
  不当作普通 assistant content

opaque provider reasoning state:
  例如 Codex Responses 的 type=reasoning + encrypted_content
  例如 Anthropic thinking signature / redacted thinking metadata
  原样持久化，adapter 按 provider 能力决定是否回放
```

推荐 canonical 存储形态：

```json
{
  "role": "assistant",
  "content": "visible assistant text",
  "provider_state": {
    "codex_reasoning_items": [
      {
        "type": "reasoning",
        "encrypted_content": "...",
        "summary": [],
        "_issuer_kind": "codex_backend"
      }
    ]
  }
}
```

规则：

- 不解密、不改写、不压平成 assistant content。
- 按 provider / endpoint 打 issuer 标记，例如 `codex_backend`、`xai_responses`、`github_responses`。
- 只有同 issuer 的 Responses adapter 才能回放对应 `encrypted_content`。
- 切换 provider、切换 endpoint 或进入 Chat Completions adapter 时，必须过滤这些 provider 私有字段。
- 如果 provider 返回 `invalid_encrypted_content`，本 session 禁用 encrypted reasoning replay，清掉历史里的对应 opaque state，然后重试一次。
- compact 可以保留 tail 中仍相关的 reasoning state；被 compact 掉的 reasoning state 不应写进自然语言 summary，只能作为 provider_state 继续保留或安全丢弃。

这借鉴 Hermes 的策略：把加密 reasoning 当作“endpoint 绑定的连续性状态”持久化和同源回放，而不是把它当作可读文本或普通 prompt。

### 为什么 hook / memory / plan 默认持久化

这是选择 Codex 路线的关键。只要某段内容会影响 agent 后续决策，就不应只在当前 user prompt 后面临时拼一次，否则后续 request、下个 turn、resume 或 debug 时都会出现“模型当时看过但 transcript 里没有”的断层。

因此默认路径是：

```text
hook/plugin/memory/plan selected context
  -> canonical developer item
  -> append to conversation timeline
  -> persist to session store / rollout
  -> later request replay
```

只有明显一次性的 runtime 信息才用 `api_only`：

```text
api_only:
  transport retry notice
  request id / trace id
  transient token budget warning
  temporary UI hint
  provider-specific cache_control marker
```

---

## 三、Codex / OpenAI Responses-style 组装

OpenAI Responses 是最接近 canonical timeline 的 provider。推荐映射：

```text
request.instructions:
  base system prompt / frozen rules

request.input:
  developer: initial context bundle
  user/developer: workspace context
  user: historical user messages
  assistant: historical assistant messages
  reasoning: encrypted reasoning state, if available
  tool call/output items
  developer: hook/plugin/memory/plan recalls
  summary: compact summary
  user: current input
```

顺序不是按 role 分组，而是按 timeline append 顺序。

### 首个真实 turn

```text
instructions:
  system frozen

input:
  developer: permissions / collaboration mode / memory tool instructions / skills / plugins
  user or developer: workspace rules / environment baseline
  user: current user input
  developer: hook/plugin additional context, if selected
  developer: memory recall / plan recall, if selected
```

### 后续 turn

```text
instructions:
  system frozen

input:
  persisted timeline replay
  developer: settings/context diff, if any
  user: current user input
  developer: newly selected hook/plugin/memory/plan context
```

### Tool continuation

```text
input:
  ... previous timeline
  assistant: tool_call
  tool: tool_result
  developer: any continuation context update
```

当前用户输入不需要重复伪造一遍；continuation 依赖 timeline 中已经存在的 user message、tool result 和新增 context。

### Prefix cache 对 Responses 的含义

Codex / Responses-style 路线不依赖 Anthropic `cache_control`。缓存命中主要来自：

```text
1. frozen system/instructions 不变
2. append-only timeline 不改写旧前缀
3. context update 只追加 diff，不重排历史
4. compact 是明确 rewrite 边界，rewrite 后重新建立稳定前缀
5. 可选 prompt_cache_key/session cache key
```

代价是上下文会增长，所以必须有 compact。

### Codex encrypted reasoning replay

Responses adapter 应支持 Codex/Hermes-style encrypted reasoning replay：

```text
request:
  reasoning: {effort: ..., summary: "auto"}
  include: ["reasoning.encrypted_content"]

response output:
  item type=reasoning encrypted_content=...

persist:
  assistant.provider_state.codex_reasoning_items[]

next request:
  replay same-issuer reasoning item before / around matching assistant history
```

回放规则：

```text
same issuer:
  replay encrypted reasoning item

foreign issuer:
  drop item before request

provider rejects invalid_encrypted_content:
  disable replay for current session
  strip stored codex_reasoning_items from active history
  retry once without encrypted reasoning
```

注意：`reasoning.encrypted_content` 是 Responses lane 的 wire capability。Chat Completions adapter 必须剥离它；Anthropic adapter 只能处理 Anthropic 自己的 thinking/signature 形态。

---

## 四、OpenAI-compatible Chat Completions 适配

OpenAI-compatible Chat Completions 不是 Codex/Responses。它只能接收 `messages[]`，provider 对 `developer` role、tool schema、reasoning 字段、cache 行为的支持差异很大。

因此 Chat adapter 的职责是：**尽量表达 canonical timeline，不允许悄悄丢失持久上下文；无法无损表达时显式降级并记录 capability gap。**

### Role 映射

```text
system frozen:
  -> role=system

developer context:
  -> role=developer, if provider supports developer
  -> otherwise merge into system or high-priority user block

user:
  -> role=user

assistant:
  -> role=assistant

tool call / tool result:
  -> Chat Completions tool_calls / role=tool, if supported
  -> otherwise fallback to structured text blocks

reasoning encrypted state:
  -> not supported by standard Chat Completions
  -> preserve in local transcript only, unless provider exposes compatible reasoning_content/reasoning_details
```

### Cache 策略

Chat-compatible provider 的 prefix cache 通常没有统一协议。`mycli` 只保证：

```text
1. frozen system 尽量 byte-stable
2. developer/context items append-only，不改写旧消息
3. tool_call arguments JSON 稳定化
4. compact 后重新建立 summary + rehydration + tail
5. provider-specific cache key/header 只在 adapter 层添加
```

Chat adapter 不使用 Anthropic `cache_control`。如果某个 OpenAI-compatible provider 有自定义 cache 字段，必须作为 wire-only provider option，不写回 canonical timeline。

---

## 五、Anthropic Messages 适配

Anthropic 不应改变内部 canonical timeline。adapter 只在发送前做映射。

### Role 映射

Anthropic Messages 没有 `developer` role，因此：

```text
system / developer frozen/stable:
  -> top-level system content

developer append_only context:
  -> system content blocks 或靠近 tail 的 user text block
     具体由 adapter policy 决定，但不能丢

user:
  -> messages[].role = "user"

assistant:
  -> messages[].role = "assistant"

tool result:
  -> user content block: {"type": "tool_result", ...}

thinking / reasoning:
  -> Anthropic thinking block / redacted thinking metadata, if provider supports replay
```

### Hermes-style cache_control

Anthropic adapter 在 API payload copy 上应用 `system_and_3`：

```text
breakpoint 1:
  system prompt

breakpoint 2-4:
  last 3 non-system messages
```

marker：

```json
{"type": "ephemeral"}
```

或配置 1h：

```json
{"type": "ephemeral", "ttl": "1h"}
```

放置规则：

```text
content 是 string:
  转成 [{"type": "text", "text": content, "cache_control": marker}]

content 是 list:
  marker 放最后一个 content block

content 是 None 或 "":
  marker 放 message 顶层，避免空 text block 被拒绝

role == tool:
  native Anthropic 才允许顶层 marker
  OpenRouter / third-party Anthropic-compatible 默认跳过
```

注意：`cache_control` 是 **wire-only**，不写回 canonical timeline。

### Anthropic 下如何同时持久化全部上下文

“持久化全部 context”和“Hermes-style cache_control”不冲突：

```text
canonical timeline:
  持久化所有 agent-visible context

anthropic request copy:
  从 canonical timeline render
  provider adapter 折叠 developer/system
  apply cache_control
  send
```

也就是说，Anthropic 也 replay 所有持久上下文，只是 cache hint 的添加方式采用 Hermes。

---

## 六、Compact 设计

Compact 是 timeline rewrite。它不是普通 overlay。

### Unified compact lane

`mycli` 的默认 compact 策略应统一走一条主路径：**canonical compact engine**。

```text
canonical timeline
  -> deterministic cheap pruning
  -> summary generation
  -> rehydration selection
  -> tail protection
  -> replacement canonical timeline
  -> provider adapter projection
```

这样做比按 provider 分三套 compact 更稳：

- compact 的语义、测试和恢复策略只有一套。
- Chat Completions、Anthropic、Responses replay 都从同一个 replacement canonical timeline 出发。
- Provider adapter 只负责 wire projection、cache hint、schema sanitize 和 provider-private state replay。
- Anthropic 仍可在发送时使用 Hermes-style `cache_control`，但不改变 compact engine。
- Responses adapter 仍可 replay `codex_reasoning_items` / `codex_message_items`，但不拥有一套单独的 compact 语义。

`/responses/compact` 这类 provider-native compact 可以作为未来优化或实验开关，但不是当前阶段默认路径。启用时必须证明它生成的 replacement timeline 与 canonical compact engine 的不变量一致，包括 rehydration、tail boundary、provider state 过滤和 prefix-cache diagnostics。

### Compact 前

```text
timeline:
  system frozen reference
  workspace/context items
  user/assistant/tool/reasoning...
  hook/memory/plan developer items...
```

在进入 summary 前，canonical compact engine 应先精简可安全降噪的旧内容：

```text
local cheap pruning:
  旧 text / structured text tool output -> 结构化一行摘要
  重复 tool result -> 保留最新完整副本，旧项改成 back-reference
  大型 tool_call arguments -> 在 JSON 内截断并保持 JSON 有效
  最近 tail -> 保留原始内容
  tool_call/tool_result group -> 不切断
```

这一步不调用 LLM，也不压 frozen/stable 区。它只作用于将要被 compact 的旧 replay 区，用来降低 summary 成本、减少 context overflow，并保护 prefix-cache 的 stable boundary。

当接近上下文窗口时，compact 生成：

```text
compaction summary:
  role=assistant 或 kind=summary
  metadata.compaction=true
  persisted=true
  replay=true
```

同时保留 tail：

```text
tail messages:
  最近 N 条 user/assistant/tool/reasoning items
  保证未闭合 tool_call/tool_result 不被切断
```

### Compact 后 active conversation

```text
active timeline:
  frozen system reference
  stable workspace/context baseline
  assistant summary(metadata.compaction=true)
  tail messages
```

raw transcript 归档，不直接参与后续 request。

### Compact 后复水

compact 之后，下一次继续工作必须显式复水。复水内容分两类：

```text
1. durable rehydration:
   必须成为后续上下文的内容，追加进 canonical timeline

2. turn rehydration:
   只服务 compact 后当前 turn 的 continuation，可标为 turn-scoped
```

用户当前要求的默认方向是：**像 Codex 一样，复水内容也应该进入上下文；如果它影响 agent 接着工作，应持久化。**

推荐复水顺序：

```text
instructions/system:
  frozen system 不变

timeline/input:
  stable workspace baseline
  compact summary
  rehydration developer items:
    - current objective
    - active plan state
    - relevant memory recall
    - invoked skills / skill bodies needed to continue
    - important files or file summaries
    - unresolved tool/task state
  tail messages
  current user input
```

示例：

```text
request after compact:
  [system frozen]
  [workspace stable context]
  [assistant summary, metadata.compaction=true]
  [developer rehydration: active goal + plan step]
  [developer rehydration: selected memory]
  [developer rehydration: invoked skill instructions needed after compact]
  [developer/user rehydration: relevant file summaries]
  [tail messages]
  [user current input]
```

### Frozen 区不变

compact 不应该改 frozen system。以下内容保持稳定：

```text
base system prompt
product identity
global safety/tool-use rules
stable skill catalog metadata
stable workspace rules, if unchanged
```

compact 只能替换 conversation history 区：

```text
old long history
  -> summary + rehydration + tail
```

### Skill 复水

skill 需要区分：

```text
skill catalog metadata:
  frozen/stable，compact 后仍在

invoked skill body:
  如果 tail 中仍有 tool result，保留即可
  如果被 compact 掉但当前任务还依赖它，写入 rehydration developer item
  如果不再需要，不复水
```

不要把所有 skill body 永久塞进 frozen system。只有已触发、当前任务仍需要的 skill 正文进入 rehydration/timeline。

---

## 七、场景模拟

### 场景 1：全新 session

```text
OpenAI Responses:
  instructions:
    system frozen

  input:
    developer: initial context bundle
    user/developer: workspace rules
    user: "帮我看下这个项目"
```

持久化：

```text
timeline append:
  developer initial context
  workspace context
  user input
```

### 场景 2：hook / plugin additional context

```text
hook returns:
  "当前仓库有 context-management change 正在进行..."
```

Codex/Responses-style：

```text
timeline append:
  user: current input
  developer: hook/plugin additional context
```

Anthropic：

```text
canonical timeline 同样 append developer item
adapter render 时折叠到 Anthropic-compatible payload
cache_control 只在 API copy 上加
```

### 场景 3：memory / plan recall

```text
selected memory:
  "auth refactor requires backward compatible public API"

active plan:
  "step 3: update token validation tests"
```

持久化为：

```text
developer: <memory_context>...</memory_context>
developer: <plan_context>...</plan_context>
```

这样下个 turn 不需要重新靠插件“想起来”这两段；它们已经是 agent timeline 的一部分。

### 场景 4：tool continuation

```text
timeline:
  user: "检查 pyproject"
  assistant: tool_call(Read)
  tool: pyproject.toml content
  assistant: analysis / next tool_call
```

后续 request 直接 replay timeline。不会临时拼回旧 user prompt。

### 场景 5：compact 后继续当前 turn

```text
active timeline after compact:
  assistant summary(metadata.compaction=true)
  developer rehydration: active objective
  developer rehydration: current plan
  developer rehydration: selected memories
  developer rehydration: required skill body summaries
  user/assistant/tool tail
  user current input or continuation marker
```

如果复水内容会影响后续多个 turn，应持久化。如果只是当前 continuation 的技术提示，可标 `turn_scoped=true`，但默认不要丢。

### 场景 6：compact 后下一个用户 turn

```text
request:
  system frozen
  stable workspace
  summary + durable rehydration + tail
  user new input
```

如果上轮 rehydration 被标为 durable，它继续 replay。如果标为 turn-scoped，它不会出现。

---

## 八、Provider Request Builder 规则

### OpenAI Responses Adapter

```text
input = timeline.for_prompt()

role mapping:
  system frozen -> instructions
  developer -> input item role=developer
  user -> input item role=user
  assistant -> output/history item
  tool -> function/tool output item
  reasoning -> reasoning item with encrypted_content if available
  summary -> assistant message with metadata.compaction=true
```

不做 Hermes `cache_control`。

### OpenAI Chat Completions Adapter

```text
canonical timeline -> messages[]
system frozen -> role=system
developer -> role=developer, if supported
reasoning encrypted state -> not supported, keep only if provider exposes compatible field
tool result -> role=tool
summary -> assistant message with metadata if local store supports it
```

如果 provider 不支持 `developer` role，adapter 必须降级：

```text
developer context -> system block or high-priority user/developer-compatible text
```

降级不能丢失持久上下文。

### Anthropic Messages Adapter

```text
canonical timeline -> anthropic system + messages
apply system_and_3 cache_control on API copy
send
```

provider-specific marker 不回写：

```text
canonical item.metadata.cache_control = absent
wire block.cache_control = present
```

---

## 九、实现约束

本节把 Codex/Hermes 中已经验证过的做法转成 `mycli` 的硬性实现要求。目标不是复制某个项目的所有实现，而是保留它们在 provider state、compact、cache 和恢复策略上的边界感。

### Provider state 必须有专用通道

`mycli` 不应把 provider 私有字段混入普通 `content`。

必须支持：

```text
provider_state.codex_reasoning_items
provider_state.codex_message_items
provider_state.anthropic_thinking_blocks / signatures
provider_state.provider_specific_tool_ids
```

规则：

- canonical timeline 可以持久化 provider state。
- wire adapter 决定哪些 provider state 能发送。
- Chat Completions adapter 默认剥离 Codex/Anthropic 私有字段。
- provider state 不进入自然语言 compact summary；需要保留时继续作为 provider state 或在安全边界处丢弃。

### Responses item replay 要保护 prefix cache

Codex/Responses lane 不只回放可见 assistant 文本，还应尽量回放 Responses 原始结构中有缓存意义的 assistant message item：

```text
assistant message item:
  type=message
  role=assistant
  status=completed
  id, if provider supplied
  phase, if provider supplied
  content output_text blocks
```

这样可以减少“把 provider 原始 item 压平成文本再重建”的形状漂移。`codex_message_items` 和 `codex_reasoning_items` 都属于 Responses adapter 的 replay 表面。

### 所有 fallback id 必须 deterministic

当 provider 没给 tool call id / response item id 时，`mycli` 必须用稳定输入生成 fallback id：

```text
seed = tool_name + canonical_json(arguments) + index
id = hash(seed)
```

禁止在 provider-visible replay 中使用随机 UUID。随机 id 只允许存在于 trace/request id 等 `api_only` metadata 中。

### Wire adapter 必须 schema-sanitize

canonical timeline 可以保存丰富字段，但每个 wire adapter 必须有明确投影：

```text
Responses adapter:
  保留 Responses 支持的 provider_state

Chat Completions adapter:
  剥离 codex_reasoning_items / codex_message_items
  剥离 response_item_id / provider-only call_id
  剥离 _ 开头 internal scaffolding
  剥离 tool_name 等本地索引用字段

Anthropic adapter:
  只发送 Anthropic 支持的 thinking/tool_result/cache_control 形态
```

不允许把 provider 不认识的字段“试着发过去”。严格 provider 会 400，宽松 provider 会掩盖问题。

### Compact 是 lifecycle event

compact 不是一个纯函数式消息替换。它必须触发 lifecycle：

```text
before_compact:
  context engines / future memory providers 抢救即将被压缩的信息
  trace 记录 compact reason、token pressure、boundary

compact:
  summary + rehydration + tail

after_compact:
  session lineage 更新
  context engines 收到 session switch
  future memory/index providers 可接入同一 lifecycle
  tool/file-read dedup 状态按需要清理
```

如果 compact 导致 session id 或 active transcript id 轮转，应保留 parent/child lineage，而不是当作全新无关 session。

### Tail boundary 必须保护当前任务

compact tail 不应简单保留最后 N 条。必须满足：

- frozen system 不变。
- 最近的 user message 必须保留在 tail，不能只出现在 summary 里。
- tool_call / tool_result group 不能被切断。
- tail 优先用 token budget，message count 只是最低保护线。
- 本阶段不实现 multimodal envelope；历史图片/截图等 rich payload 只作为未来 adapter 能力预留。

### Compact 前先做 cheap pruning

在调用 summary model 前，先做确定性降噪。这个策略主要借鉴 Hermes，并作为 `mycli` 所有 provider lane 的默认 compact 前置步骤。

- 重复 tool result 去重，旧重复项改为 back-reference。
- 大型旧 tool output 改成结构化一行摘要。
- 旧截图/base64 payload 的专门处理延后到 multimodal 阶段；当前阶段只处理 text / structured text tool result。
- 大型 tool_call arguments 在 JSON 结构内截断，保持 JSON 有效。
- 保留最新 tail 的原始内容，避免把当前工作材料提前摘要掉。

这一步不依赖 LLM，能显著降低 compact 成本和失败率。

边界：

- 不处理 frozen system、stable workspace rules、stable skill catalog 或 tool schema。
- 不把 provider-private reasoning state 写入自然语言摘要。
- 不把 Responses 原始 provider item 压平成普通文本；需要保留 shape 时放在 provider_state，由 adapter replay。
- 不实现 multimodal payload shrink；图片/截图/base64 的历史处理留到后续阶段。

### Summary 失败不能静默丢历史

compact summary 失败时必须选择明确策略：

```text
safe mode:
  abort compact
  保留原 messages
  提示用户或 runtime 稍后重试

fallback mode:
  插入明确 summary unavailable marker
  记录 dropped_count / failure reason
  不假装 compact 成功
```

默认更推荐 safe mode。任何丢弃历史的 fallback 都必须有 telemetry 和用户可见 warning。

### ErrorClassifier 驱动恢复

provider error 需要先归类，再由 recovery policy 决定动作：

```text
invalid_encrypted_content:
  strip encrypted reasoning replay state
  disable session replay
  retry once

context_overflow:
  compact or shrink payload
  retry

image_too_large:
  deferred to multimodal phase
  current text-only phase should surface as unsupported payload recovery

schema_rejected:
  sanitize adapter projection
  retry only if deterministic repair exists
```

不要在多个 adapter 中分散字符串匹配。

### Redaction 是持久化边界

脱敏不只是日志功能。以下边界都要过 redaction：

- assistant content 入 timeline 前
- tool result 入 timeline 前
- compact summary 持久化前
- request/response debug dump 写盘前
- future memory extraction / session search 索引前

provider-private encrypted state 本身不应被自然语言 redaction 改写；它要么作为 opaque state 原样保存，要么整体丢弃。

---

## 十、测试要求

必须覆盖：

- Codex/Responses request 中 hook/plugin additional context 会进入 persisted timeline。
- 外部已选中的 memory/plan context 会作为 developer item replay 到下一 turn；本阶段不测试完整记忆系统。
- Chat Completions adapter 会 replay 同一份 canonical context，并在 provider 不支持 `developer` role 时显式降级。
- Chat Completions adapter 不伪造标准不存在的 `reasoning.encrypted_content`。
- Anthropic adapter 会 replay 同一份 canonical context，但只在 wire copy 上加 `cache_control`。
- Anthropic `system_and_3` 最多 4 个 breakpoints。
- Anthropic `cache_control` 不写回 session transcript。
- compact 后 active conversation 是 `summary + rehydration + tail`。
- frozen system 在 compact 前后 hash 不变。
- invoked skill body 被 compact 掉但当前任务仍需要时，会进入 rehydration。
- tail message 保留 tool_call/tool_result 成对关系。
- OpenAI Responses 保留 reasoning encrypted state；Chat Completions/Anthropic 不支持时必须显式降级。
- OpenAI Responses 保留并 replay `codex_message_items`，Chat Completions adapter 会剥离。
- fallback tool_call id 是 deterministic，重复输入不会生成不同 id。
- compact 前 cheap pruning 不破坏 tool_call arguments JSON。
- compact summary 失败时不会静默删除历史。
- provider error `invalid_encrypted_content` 会禁用 encrypted reasoning replay 并重试一次。

---

## 十一、评审检查表

修改 context/request/session 组装前检查：

- 这段内容是否会影响 agent 后续工作？
- 如果会，为什么不持久化？
- 它应是 frozen、stable、append_only、tail，还是 api_only？
- 它在 OpenAI Responses 中映射到什么 role/item？
- 它在 Chat Completions 中是否能无损表达？不能时如何降级？
- 它在 Anthropic Messages 中折叠到 system 还是 messages？
- 它是否会破坏 Anthropic `cache_control` 的 system_and_3 布局？
- compact 后它是否需要复水？
- 它是 durable rehydration 还是 turn-scoped rehydration？
- 它是否会让 tool_call/tool_result 断裂？
- provider-specific 字段是否泄漏进 canonical transcript？
- provider-specific 字段是否泄漏到不支持的 wire adapter？
- fallback id 是否 deterministic？
- compact 失败时是否会静默丢历史？

默认决策：

```text
agent 需要持续知道 -> persistent append_only context item
只服务传输/缓存/调试 -> api_only
Anthropic cache_control -> wire-only
compact 后继续工作所需内容 -> rehydration item
```
