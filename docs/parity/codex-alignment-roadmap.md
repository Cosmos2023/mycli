# mycli Codex Alignment Roadmap

本文档定义 `mycli` 接下来如何向 Codex-style coding agent 靠齐。

当前结论：

```text
mycli 的 context/cache/provider edge 已经补得比较厚。
下一阶段重点不是继续堆 provider quirks，而是把 runtime kernel 做厚。
```

目标不是复制 Codex，也不是放弃 Hermes 经验。目标是让 `mycli` 的核心主干更像 Codex：

```text
canonical timeline / turn rollout / tool runtime / execution policy
  -> request projection
  -> provider adapter
  -> trace / recovery / diagnostics
```

Hermes-style 经验继续保留在 provider edge：

```text
Anthropic cache_control
DeepSeek quirks
OpenAI-compatible 差异
usage/cache telemetry normalization
provider-specific defensive stripping
```

---

## 1. 总体判断

### 当前 mycli 已经接近 Codex 的部分

`mycli` 已经具备 Codex-style 主干的雏形：

- `CanonicalTimelineItem`：开始表达 role、scope、durability、provider_state。
- `HistoryItem` / `TurnRollout` / `SessionRuntimeSnapshot`：开始把 transcript、runtime event、continuation state 分开。
- `RuntimeItem` / `RuntimeBlock`：开始把 provider-facing item 与普通文本 prompt 区分开。
- `RequestShape` / provider projection：开始把 canonical request shape 投影到 Responses / Chat / Anthropic lanes。
- `RuntimeEventLedger`：开始把 turn item、trace event、context baseline、rollout state 落库。
- `ToolExecutionService` / tool lifecycle：开始记录 tool start/progress/complete/failure。

这些方向是对的。问题是它们还没有完全成为“唯一事实源”。

### 当前 mycli 还偏 Hermes 的部分

最近几轮工作主要落在 provider/cache 兼容层：

- `prompt_cache_key`
- Anthropic `system_and_3` / `cache_control`
- DeepSeek automatic prefix cache profile
- provider cache usage telemetry
- dry-run request shape diagnostics
- doctor cache triage

这些能力有价值，但它们不应该反过来支配 runtime 架构。正确边界是：

```text
Codex-style runtime kernel 是主干。
Hermes-style provider quirks 是边缘策略。
```

---

## 2. Codex-style 核心不变量

### 2.1 Canonical Timeline 是事实来源

所有 agent 后续需要知道的内容都应进入 canonical timeline 或 runtime ledger，而不是只临时拼进某次 prompt。

必须进入 durable timeline 的内容：

- user message
- assistant message
- tool call / tool result
- compact summary / rehydration context
- selected workspace instructions
- selected plan / memory-like context
- skill instructions that were actually activated
- provider-private replay state metadata

不应进入 durable timeline 的内容：

- request id / trace id
- raw provider wire payload body
- full `prompt_cache_key`
- Anthropic `cache_control`
- one-shot transport metadata
- secret-like values

### 2.2 Provider Payload 只是 Projection

不同 provider 不能拥有不同的“事实历史”。

```text
canonical timeline
  -> RequestShape
  -> provider runtime items/messages
  -> provider adapter wire payload
```

Responses、Chat Completions、Anthropic Messages 都应从同一份 canonical state 投影出来。差异只允许存在于 adapter edge。

### 2.3 Runtime Enforcement 不能只靠 Prompt

Codex 的 `<environment_context>`、`<permissions>`、`AGENTS.md` 这类内容是 model-visible contract，不是安全边界本身。

`mycli` 应采用同样的双层结构：

```text
Prompt contract:
  告诉模型当前环境、权限、sandbox、approval policy、工具边界

Runtime enforcement:
  由 ToolRuntime / ExecutionPolicy / SandboxProfile / ApprovalGate 强制执行
```

模型看见规则是为了减少错误调用；真正的安全由 runtime 决定。

### 2.4 Tool Runtime 是单一执行入口

所有工具形态都应进入同一个 runtime lifecycle：

```text
prepare
  -> policy check
  -> approval gate
  -> execute
  -> observe progress
  -> record result
  -> recover or finalize
```

适用对象包括：

- builtin tools
- shell / file / patch
- MCP tools
- plugin contributed tools
- hook tools
- subagent tools
- skill activation surface

工具不应该绕过 runtime 自己执行高风险动作。

### 2.5 Skill 不应长期作为普通 Tool 心智

当前 `mycli` 仍把 skill 注册成 contributed tool。这个做法可作为兼容阶段，但长期更 Codex 的方向是：

```text
skill metadata:
  用于 discovery / trigger / capability description

skill instructions:
  在命中或显式激活后注入 context/timeline

skill execution:
  不是每个 skill 都变成一个 provider-visible tool schema
```

短期允许保留 `skill_*` provider-safe tool 作为过渡，但需要逐步变成：

- skill catalog 是 stable context。
- active skill instructions 是 durable context item。
- skill activation 是 runtime event / timeline item。
- provider-visible tool schema 不随 skill 数量线性膨胀。

---

## 3. mycli 当前差距

| Area | 当前状态 | Codex-style 目标 |
| --- | --- | --- |
| Runtime kernel | 已有 `AgentRuntime`、ledger、tool execution，但策略分散 | 统一 `ToolRuntime` + `ExecutionPolicy` + `ApprovalGate` |
| Sandbox | 有 workspace/root 约束和工具级 guard | 明确 `SandboxProfile`，覆盖 fs/network/shell/env/cwd |
| Approval | 有 pending decision/approval lifecycle | 所有高风险动作统一经 runtime gate |
| Tool execution | builtin/contributed/MCP/subagent 已接入一部分 | 所有 tool-like action 走同一 lifecycle |
| Timeline | 有 canonical/timeline/history/rollout 数据结构 | timeline 成为唯一 replay source |
| Provider state | 已开始隔离 `provider_state` 和 wire-only metadata | Responses/Anthropic/DeepSeek 私有状态可同源安全回放 |
| Skills | 仍偏 contributed tool | 迁移到 trigger + context injection + timeline event |
| Compact | 有 canonical compact/rehydration 方向 | compact 是正式 timeline rewrite 边界 |
| Diagnostics | cache/provider diagnostics 较强 | runtime enforcement、approval、sandbox、resume diagnostics 同样强 |

---

## 4. 目标架构

### 4.1 Runtime Kernel

建议补出以下核心对象：

```python
@dataclass(frozen=True)
class SandboxProfile:
    workspace_roots: tuple[Path, ...]
    cwd: Path
    filesystem: Literal["read_only", "workspace_write", "unrestricted"]
    network: Literal["disabled", "enabled"]
    shell: Literal["disabled", "restricted", "enabled"]
    env_policy: EnvPolicy


@dataclass(frozen=True)
class ExecutionPolicy:
    approval_policy: ApprovalPolicy
    sandbox: SandboxProfile
    command_policy: CommandPolicy
    file_policy: FilePolicy
    tool_policy: ToolPolicy


class ApprovalGate(Protocol):
    def decide(self, request: ApprovalRequest) -> ApprovalDecision:
        ...


class ToolRuntime:
    def execute(self, call: ToolCall, context: ToolExecutionContext) -> ToolExecutionResult:
        ...
```

关键要求：

- policy decision 必须在工具执行前发生。
- policy result 必须写入 trace/ledger。
- approval pending 必须可恢复。
- rejected/denied 必须是 terminal runtime state，不是普通 tool failure 文本。

### 4.2 Canonical Turn Spine

每个 turn 应形成一条清晰主链：

```text
UserInput
  -> TurnContextAssembly
  -> RequestShape
  -> ModelRequest
  -> ModelEventStream
  -> ToolCallPlan
  -> ToolRuntime
  -> ToolResult
  -> ModelContinuation
  -> FinalResponse / WaitingApproval / Failure / Interrupted
  -> TurnRollout
```

每个节点都应具备：

- typed event
- persisted record
- trace projection
- doctor-readable bounded diagnostics

### 4.3 Provider Edge

Provider adapter 只做这些事：

- schema projection
- field stripping
- provider-private state replay
- wire-only cache hint
- usage normalization
- provider error classification

Provider adapter 不应负责：

- 决定哪些 context 应长期存在
- 修改 canonical timeline
- 执行 compact
- 执行 tool policy
- 决定 approval

---

## 5. 分阶段路线

### P9: Runtime Kernel Contract

目标：定义并接入 `ExecutionPolicy`、`SandboxProfile`、`ApprovalGate`、`ToolRuntime` 的最小 contract。

范围：

- 梳理现有 shell/file/tool approval 分散逻辑。
- 建立 policy decision 数据结构。
- 工具执行前统一产出 `allowed / denied / needs_approval`。
- trace/doctor 能报告当前 execution policy。

验收：

- builtin tool、contributed tool、MCP tool、subagent tool 都通过同一 policy path。
- denied by policy 不执行工具。
- needs approval 可持久化并恢复。
- 单测覆盖 allow/deny/approval 三态。

### P10: Tool Runtime Lifecycle Unification

目标：所有 tool-like action 统一生命周期。

范围：

- `ToolExecutionService` 成为唯一执行入口。
- shell/file/patch/MCP/plugin/subagent/skill activation 都发出标准 lifecycle event。
- long-running tool 支持 progress、cancel、timeout、result truncation metadata。

验收：

- trace 中能按 call_id 追踪每次工具从 planned 到 completed/failed/rejected。
- doctor 能发现 orphan running tool / missing result / malformed lifecycle。
- context/subagent/MCP/plugin/hook smoke 不回退。

### P11: Skill Context Injection Migration

目标：把 skill 从“每个 skill 一个 provider-visible tool”迁移为 Codex-style capability/context source。

范围：

- skill catalog 作为 stable context。
- triggered skill instructions 作为 active context item。
- skill activation 写入 timeline/ledger。
- 保留 `skill_*` tool 作为兼容入口，但不作为长期默认机制。

验收：

- 新增 skill 不必默认改变 provider tool schema。
- 激活过的 skill instructions 能 replay。
- 删除 skill 文件后，已激活 turn 的历史不丢失。
- prefix-cache stable tool schema 不因 skill 数量变化而频繁失效。

### P12: Resume / Fork / Compact As Timeline Rewrite

目标：让 resume、fork、compact 都基于 canonical timeline，而不是临时拼接。

范围：

- root-to-tip replay contract。
- branch/fork lineage。
- compact replacement record。
- provider_state filtering and replay compatibility。

验收：

- compact 前后 stable prefix hash 不变。
- resume 后 active context 和 pending approval 状态一致。
- fork 不污染 parent transcript。
- provider-private state 不泄漏到普通 text。

### P13: Runtime Diagnostics Productization

目标：让 runtime kernel 的行为像 cache policy 一样可诊断。

范围：

- doctor 增加 execution policy、sandbox、approval、tool lifecycle checks。
- trace export 增加 bounded runtime policy fields。
- dry-run 展示 tool exposure + policy decision + provider request shape。

验收：

- doctor 能区分 unsupported、disabled by policy、needs approval、denied、missing telemetry。
- 不输出 secret、raw prompt、raw tool output、完整 provider key。
- provider-free smoke 能覆盖 runtime policy diagnostics。

### P14: Runtime ExecPolicy Rules

目标：引入最小 Codex-style execpolicy rules layer，让 `Bash` /
`run_shell` 在执行前经过 user/project/session-extension rules 判断。

范围：

- typed `prefix_rule(pattern=[...], decision="allow|deny|ask")` model。
- user rules 与 project rules loader，project rules 在多条命中时覆盖 user
  rules。
- P14 只作用于 shell lane，不扩大到所有 tool。
- `RuntimePolicyGate` 在安全策略前解析命中规则，并输出
  `allowed` / `denied` / `needs_approval`。
- trace / doctor / dry-run 只输出 rule source、decision、pattern hash、
  pattern length、argument count 等 bounded metadata。

验收：

- rule parser/loader 有单测。
- shell allow/deny/ask 有 runtime 单测。
- raw command、raw pattern tokens、secret 不进入 trace/doctor/dry-run。
- 未命中规则时 P9-P13 行为不回退。

### P15a: Runtime Environment Contract

目标：把 Codex-style runtime posture 以 bounded dynamic context 形式送进模型，
让模型知道当前 workspace、sandbox、approval、tool policy 和 execpolicy 状态。
真正的安全边界仍由 runtime enforcement 执行。

范围：

- `RuntimeEnvironmentContract` 从 `ExecutionPolicy` 和已加载 execpolicy rules
  解析 workspace root、filesystem、network、shell、approval、command、file、
  tool policy。
- `TurnContextAssembler` 在 `ENVIRONMENT_CONTEXT` 中渲染 bounded runtime
  environment block。
- `RequestShapeBuilder` 保持该 section 为 dynamic replay fragment，并在
  Responses/Chat/Anthropic projection 中作为 provider-visible context。
- 不输出 raw env、secret、raw command、raw execpolicy pattern tokens、
  stdout/stderr 或 provider payload body。
- current user input 继续保持 request tail。

验收：

- runtime environment contract 有 assembler/runtime/request-shape 单测。
- environment context 不进入 stable prefix。
- 只暴露 execpolicy enabled/disabled、rule count 和 source summary。
- compact/rehydration 实现保持未触碰。

### P15b: Runtime Enforcement Kernel

目标：把 P15a 的 runtime posture 从“模型可见事实”推进到 shell lane 的
runtime 强约束，让 `Bash` / `run_shell` 获得统一的 workspace cwd、env、
timeout、output limit enforcement。

范围：

- `ShellExecutionOptions` 从 `ExecutionPolicy` / `SandboxProfile` 解析
  filesystem、network、shell、env policy、timeout cap、output limit。
- `ToolExecutionService` 对 shell lane 注入 runtime-only enforcement
  options；该参数不进入 provider-visible tool schema，也不进入 trace
  argument keys。
- `BashTool` 使用 sanitized env allowlist 和 timeout cap 执行命令，并在
  raw payload / trace 中输出 bounded `runtime_enforcement` metadata。
- 保持 P14 execpolicy allow / deny / ask 行为。
- shell `tool_execution` trace 只保留参数 key/count、bounded enforcement
  metadata、stdout/stderr char/truncated counters；不保留 raw command、
  argument values 或 stdout/stderr preview/body。
- 不输出 raw env values、secret、raw command、raw execpolicy pattern tokens、
  stdout/stderr body 或 provider payload body。

验收：

- Bash timeout cap、sanitized env、workspace cwd 和 bounded metadata 有单测。
- tool execution trace 只暴露 bounded enforcement fields。
- runtime-only enforcement options 不改变 provider tool schema。
- compact/rehydration 实现保持未触碰。

---

## 6. 优先级

推荐顺序：

```text
P9 Runtime Kernel Contract
  -> P10 Tool Runtime Lifecycle Unification
  -> P11 Skill Context Injection Migration
  -> P12 Resume / Fork / Compact Timeline Rewrite
  -> P13 Runtime Diagnostics Productization
  -> P14 Runtime ExecPolicy Rules
  -> P15a Runtime Environment Contract
  -> P15b Runtime Enforcement Kernel
```

原因：

- 不先做 P9/P10，skill/compact/diagnostics 会继续散落在各工具和 adapter 中。
- P11 依赖稳定 tool runtime，否则 skill 从 tool 迁出时容易破坏现有 smoke。
- P12 依赖 timeline/source-of-truth 明确，否则 compact/resume 很容易变成另一套 prompt 拼接。
- P13 最后做，避免 doctor 固化还没稳定的 contract。

---

## 7. 非目标

本路线不包含：

- ACP / remote agent 产品化。
- swarm / multi-platform gateway 产品化。
- 完整 memory system。
- background maintenance。
- multimodal tool result envelope。
- provider-specific compact engine。
- 复制 Codex 或 Hermes 的源码。

这些能力可以后续独立开任务，但不应混进 runtime kernel 对齐阶段。

---

## 8. 成功标准

当以下条件满足时，可以认为 `mycli` 的核心架构已经明显向 Codex 靠齐：

- 所有模型可见上下文来自 canonical timeline / request shape projection，而不是散落 prompt 拼接。
- 所有工具调用都经过统一 runtime policy 和 lifecycle。
- sandbox、approval、exec policy 是 runtime 强约束，不只是 prompt 说明。
- provider adapters 只处理 wire projection 和 provider quirks。
- skill 不再默认导致 provider tool schema 随 skill 数量膨胀。
- resume/fork/compact 都能从 typed timeline 解释。
- doctor/trace 可以解释 runtime policy、tool lifecycle、request shape 和 provider cache 状态。

一句话：

```text
Codex 管主干，Hermes 管边缘，mycli 管 provider-neutral cache-aware coding agent。
```
