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

### P15c: Sandbox Policy Enforcement

目标：把 P15a/P15b 的 runtime posture 扩展成 effect-profile-driven sandbox
gate，让 filesystem、shell、network policy 在工具执行前成为强约束，而不是
只靠提示词或 approval 兜底。

范围：

- `ToolExecutionService` 在 runtime policy decision 前解析
  `ToolEffectProfile`。
- `RuntimePolicyGate.decide()` 先执行 sandbox denial，再进入 ExecPolicy、
  contributed-tool allow、approval service 和实际 tool execution。
- `filesystem=read_only` 拒绝 filesystem `write` 和 `unknown` effect。
- `shell=disabled` 拒绝 `Bash` / `run_shell`，即使命中 ExecPolicy allow。
- `network=disabled` 拒绝 network-effect tools。
- `runtime_policy_decision` trace row 输出 bounded sandbox/effect summary，
  只允许 argument key/count、decision/policy/reason/risk、sandbox lanes、
  effect lanes。
- doctor 继续通过 runtime policy diagnostics 汇总 sandbox denials。
- 不实现 OS sandbox、network firewall、provider API 调用或 compact/rehydration
  改造。

验收：

- read-only filesystem write/unknown effect、shell disabled、network disabled
  有单测。
- sandbox deny 发生在 ExecPolicy/approval/tool execution 前。
- trace/doctor 不输出 raw command、raw args、raw URL、stdout/stderr、secret 或
  provider payload body。
- P14 ExecPolicy 和 P15b shell enforcement 回归不退。
- compact/rehydration 实现保持未触碰。

### P16: Approval Resume Enforcement Hardening

目标：把 P14/P15 的 runtime enforcement 和 approval pause/resume 连接稳，
保证 pending approval 在 restart、`/resume`、root-to-tip lineage switch、
稀疏 session state 下仍然可解释、可恢复、可诊断。

范围：

- approval resolution 使用一致恢复顺序：
  - `pending_decision + suspended_turn.pending_approval` 正常路径；
  - 只有 `suspended_turn.pending_approval` 时 synthesize bounded
    `PendingDecision`；
  - 只有 `pending_decision` 时继续使用 runtime snapshot 重建 suspended turn。
- 新增 bounded `approval_recovery` trace/log diagnostics。
- doctor approval diagnostics 汇总 recovery result counts。
- 保持 `APPROVE_ONCE` / `REJECT` / `ALLOW_SESSION` 语义不变。
- 不输出 raw command、raw tool args、raw user prompt、raw tool output、secret、
  provider payload body。
- 不改 compact/rehydration 实现。

验收：

- suspended-only approval recovery 有回归测试。
- pending-decision-only reconstruction 回归不退。
- doctor/trace recovery diagnostics 有 redaction 测试。
- root-to-tip resume approval/clarification 回归不退。
- P14/P15 runtime policy/sandbox/shell enforcement 回归不退。
- compact/rehydration 实现保持未触碰。

### P17: Shell Process Lifecycle Hardening

目标：把 `Bash` / `run_shell` 从“能执行命令”推进到“执行后仍可治理”，补齐
foreground/background process lifecycle、timeout、interrupt、kill、doctor 诊断。

范围：

- 标准化 shell process state：
  - planned
  - policy_checked
  - started
  - running_foreground
  - running_background
  - output_capped
  - timed_out
  - interrupted
  - killed
  - completed
  - failed
- 强化 `ShellRegistry` / `KillShell` / `ToolExecutionService` 的一致性。
- timeout cleanup 和 turn interrupt cleanup 必须尝试终止子进程，并记录 bounded
  cleanup result。
- background shell 必须有 registry id、started_at、cwd policy summary、runtime
  effect summary、last_observed_at、terminal state。
- doctor 能报告 running/orphan/stale/background shell 状态。
- trace 只输出 bounded process metadata：pid 是否存在、registry id、state、
  elapsed_ms、output char count、truncated flags、cleanup result。
- 不输出 raw command、raw env、stdout/stderr body、secret。

非目标：

- 不实现 Docker/seatbelt/seccomp/云沙箱。
- 不做 shell command rewriting。
- 不改 approval 语义。
- 不改 compact/rehydration 实现。

验收：

- foreground timeout cleanup 有单测。
- interrupt cleanup 有单测。
- background registry lifecycle 有单测。
- `KillShell` policy + lifecycle + trace 有单测。
- doctor 能发现 stale/orphan/running background shell。
- P14/P15/P16 runtime policy、sandbox、approval resume 回归不退。
- compact/rehydration 实现保持未触碰。

### P18: Shell Backend Contract

目标：抽出 shell backend contract，让当前 local subprocess 是一个 backend，
未来 Docker/seatbelt/remote backend 可以接入，但本期不默认实现重型隔离。

范围：

- 定义 provider-neutral `ShellBackend` / `ShellProcessHandle` / `ShellBackendResult`
  contract。
- local backend 复用 P17 process lifecycle。
- backend selection 来自 runtime profile / sandbox profile，默认仍为 local。
- backend capability 进入 bounded runtime environment 和 doctor summary。
- doctor 能解释 backend unavailable / unsupported / disabled-by-policy。

非目标：

- 不默认上 Docker backend。
- 不实现 SSH/Modal/Daytona/Singularity。
- 不实现网络 firewall 或 OS sandbox。
- 不改 provider request shape。
- 不改 compact/rehydration 实现。

验收：

- local backend contract 有单测。
- backend capability resolution 有单测。
- backend unavailable / disabled-by-policy doctor diagnostics 有单测。
- 现有 shell eval/smoke 不回退。

### P19: Background Tool Runtime Completeness

目标：把 long-running tool 和 background job 从 shell 单点能力扩展成统一 runtime
能力，覆盖进度、取消、恢复诊断和 terminal state。

范围：

- 标准化 background job model：tool call id、job id、owner turn、state、
  started_at、last_event_at、terminal result summary。
- tool lifecycle 支持 detach / observe / cancel / collect result。
- doctor 能发现 orphan job、missing terminal state、cancel failed、stale progress。
- trace 输出 bounded lifecycle counters，不输出 raw tool output body。
- shell background 复用 P17/P18；其他 tool-like action 通过同一 contract 暴露。

非目标：

- 不做 cron/background maintenance 产品化。
- 不做分布式 worker。
- 不做 remote agent/swarm。
- 不改 compact/rehydration 实现。

验收：

- background job state machine 有单测。
- cancel / collect / stale diagnostics 有单测。
- shell background 与 generic background job id 能互相解释。
- context/subagent/MCP/plugin/hook smoke 不回退。

### P20: Skill Runtime Finalization

目标：收束 P11 的兼容迁移，让 skill 长期形态稳定为 catalog + activation +
context/timeline，而不是 provider-visible tool schema 随 skill 数量膨胀。

范围：

- 默认 provider-visible surface 保持一个稳定 `Skill` / skill activation 工具或
 等价入口。
- skill catalog 作为 stable capability context，未激活 skill 不注入完整指令。
- active skill instructions 落入 replayable timeline/context snapshot。
- skill 文件被删除、改名、升级时，历史 turn 仍能 replay 已激活语义。
- doctor 能报告 skill catalog drift、missing activated skill snapshot、tool schema
  stability。

非目标：

- 不做完整 marketplace。
- 不做 skill package manager 产品化。
- 不把所有 skill 都暴露成独立 provider tool。
- 不改 compact/rehydration 实现。

验收：

- 新增/删除未激活 skill 不改变默认 provider tool schema。
- activated skill replay 有单测。
- missing skill file 的历史 replay 有单测。
- doctor skill runtime diagnostics 有单测。
- prefix-cache stable tool schema 回归不退。

### P21: Provider Edge Quirk Registry And Eval Matrix

目标：把已经积累的 DeepSeek / OpenAI-compatible / Responses proxy /
Anthropic-style edge 行为沉淀为显式 provider quirk registry 和可回归 eval matrix，
避免 quirks 散落在 adapter 条件分支里。

范围：

- 标准化 provider quirk metadata：
  - prompt cache mechanism
  - supports / rejects `prompt_cache_key`
  - Anthropic `cache_control` behavior
  - encrypted reasoning handling
  - usage cached-token shape
  - streaming event quirks
  - retry/error classification quirks
- local/fake provider fixtures 覆盖主要 quirks。
- live eval 只作为显式 opt-in，不进入默认测试。
- doctor/provider diagnostics 输出 bounded quirk summary。

非目标：

- 不做真实 provider API 默认调用。
- 不扩大 provider-specific compact engine。
- 不把 provider quirks 放进 canonical timeline。
- 不改 compact/rehydration 实现。

验收：

- quirk resolution 有单测。
- DeepSeek OpenAI-compatible / DeepSeek Anthropic-style / Responses proxy fixtures
  有本地回归。
- streaming + usage normalization fixtures 有单测。
- redaction 边界不回退。

### P22: Evaluation Quality Harness

目标：把当前 smoke/eval 变成可长期比较的质量回归矩阵，覆盖 coding agent 的真实
任务链路，而不是只验证单个 provider 或单个 tool。

范围：

- 扩充 provider-free scenario corpus：
  - file edit
  - patch failure recovery
  - approval pause/resume
  - sandbox deny
  - background shell lifecycle
  - subagent delegation
  - MCP/plugin/hook smoke
  - skill activation replay
  - provider request shape stability
- 为每个 scenario 输出 bounded score/report。
- 支持本地 fake model / fake provider / dry-run mode。
- 可选 live provider eval 需要显式配置和 redacted result capture。

非目标：

- 不引入第三方 eval 平台。
- 不默认跑真实 provider API。
- 不做网页 dashboard。
- 不改 compact/rehydration 实现。

验收：

- scenario runner 有文档和单测。
- 至少覆盖 P14-P21 的关键 runtime/provider regression。
- eval artifact 不包含 raw secret、raw provider payload body、raw tool output body。
- CI/本地都能 provider-free 跑核心矩阵。

### P23: External Gateway / ACP Readiness

目标：在 runtime/tool/approval/event contract 稳定后，定义最小外部协议 readiness，
为未来 HTTP/Webhook/ACP 做准备，但不在本阶段产品化多平台 gateway。

范围：

- 定义 gateway-facing manifest：
  - tools
  - toolsets
  - approval actions
  - runtime event stream
  - session/turn ids
  - redaction contract
- Node TUI gateway 与 manifest/event contract 对齐。
- doctor 能检查 gateway manifest/runtime consistency。
- ACP 只做 contract gap list，不实现 adapter。

非目标：

- 不实现 ACP server。
- 不做 Slack/Telegram/remote agent/swarm。
- 不做 OAuth/auth 产品化。
- 不改 compact/rehydration 实现。

验收：

- gateway manifest contract 有单测。
- Node TUI gateway smoke 不回退。
- doctor manifest/runtime consistency 有单测。
- ACP readiness 文档列出阻塞项和后续阶段。

### P24: Memory And Maintenance Readiness

目标：只定义 memory/background maintenance 的边界和 readiness，不把完整 memory
system 或 background maintenance 混进 runtime kernel 阶段。

范围：

- 明确 memory-like context 的 durable/timeline/request-shape 边界。
- 明确 background maintenance 与 user turn runtime 的隔离边界。
- 定义未来 memory tool / session search / background summarization 的最小
  contract。
- 保持现有 compact/rehydration 为受保护边界，只增加只读 contract tests 或文档。

非目标：

- 不实现完整 memory system。
- 不实现 background maintenance。
- 不实现 provider-specific compact engine。
- 不模仿 Codex compact rehydration。

验收：

- readiness 文档明确数据归属、redaction、diagnostics、test plan。
- 未来 P25+ 可以基于该文档开独立 goal。
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
  -> P15c Sandbox Policy Enforcement
  -> P16 Approval Resume Enforcement Hardening
  -> P17 Shell Process Lifecycle Hardening
  -> P18 Shell Backend Contract
  -> P19 Background Tool Runtime Completeness
  -> P20 Skill Runtime Finalization
  -> P21 Provider Edge Quirk Registry And Eval Matrix
  -> P22 Evaluation Quality Harness
  -> P23 External Gateway / ACP Readiness
  -> P24 Memory And Maintenance Readiness
```

原因：

- 不先做 P9/P10，skill/compact/diagnostics 会继续散落在各工具和 adapter 中。
- P11 依赖稳定 tool runtime，否则 skill 从 tool 迁出时容易破坏现有 smoke。
- P12 依赖 timeline/source-of-truth 明确，否则 compact/resume 很容易变成另一套 prompt 拼接。
- P13 最后做，避免 doctor 固化还没稳定的 contract。
- P17-P19 接着 P14-P16 做 shell/process/background，是 runtime enforcement
  自然后半段。
- P20 等 tool/runtime 稳定后再收束 skill，避免再次把 skill 做成 provider
  schema 膨胀点。
- P21/P22 把 provider quirks 和 eval 沉淀成回归资产，但真实 provider 调用仍然
  opt-in。
- P23/P24 只做 readiness，因为 gateway/ACP/memory/background maintenance 都应在
  runtime kernel 稳定后独立产品化。

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
- filesystem、shell、network sandbox policy 能在工具执行前基于 bounded
  effect profile 强制拒绝不允许的调用。
- provider adapters 只处理 wire projection 和 provider quirks。
- skill 不再默认导致 provider tool schema 随 skill 数量膨胀。
- resume/fork/compact 都能从 typed timeline 解释。
- doctor/trace 可以解释 runtime policy、tool lifecycle、request shape 和 provider cache 状态。

一句话：

```text
Codex 管主干，Hermes 管边缘，mycli 管 provider-neutral cache-aware coding agent。
```

---

## 9. 后续待办

### 2026-09-06: 按工具调用解耦审批、执行与结果提交

状态：已完成。全量 324 个测试文件及安装包 10 条流程通过，修改保持未提交。

本轮实现：

- `ParallelApprovalCoordinator` 按调用持久化审批请求和决定，同阶段的可并行调用独立等待与执行；界面回答一项后立即推进下一项。
- 审批期间保留当前 turn 和 Worker lease，通过活动 runtime 接收回应，不再为每次回答重新启动 continuation。
- 已移除早期 `shellYieldAfterStart` 特例。获批 Shell 使用正常 `yield_time_ms`，命令 2 不需要等待命令 1 返回运行句柄。
- 沿用现有 effect ledger，以 session/turn/call 的稳定标识领取执行；恢复时复用已完成结果，对结果未知的执行中断处理，禁止自动重跑。
- 实时完成事件按实际完成顺序发出，工具结果、后置 hooks 和模型续接仍按 provider 顺序处理。写文件、权限授予和其他串行调用保留屏障。
- 非交互式 exec/review 使用持久挂起模式，遇到审批仍以 exit 3 退出并保留待办；旧单项审批状态继续兼容。

本项验收：

- [x] 同阶段调用独立等待审批和推进执行，前一调用等待输出不阻塞后一审批。
- [x] 多个请求按 ID 管理，界面一次展示一项，回答后立即推进。
- [x] 区分审批完成、调用返回与进程结束；取消和迟到审批有独立回归覆盖。
- [x] 移除 Shell 零等待特例，保留正常 `yield_time_ms` 和运行句柄语义。
- [x] 结果按序提交、审批事务回滚、完成结果复用和未知结果恢复通过专项测试。
- [x] 全量质量门槛和安装包 smoke。

剩余架构工作仍包括网络域名代理强制执行、多客户端服务生命周期，以及 provider 原生搜索的完整回放；本项完成不代表全面达到 Codex 架构对等。

验收重点：

- 同批次两个可并行 Shell 调用均已发出时，即使命令 1 尚未获批，命令 2 也能登记待审批；批准命令 1 后，命令 2 可以在命令 1 的正常输出等待窗口内独立获批并执行。
- 命令 2 未获批不得执行；重复审批、拒绝、取消和重启恢复不得造成重复执行、审批错配或结果丢失。
- 工具结果保持规定顺序；下一轮模型推理仍遵守批次结果收集边界，运行句柄不代表进程成功退出。

源码依据：本机 Codex 源码快照，无 Git 元数据，无法确认具体 commit；结论来自静态阅读，未运行其 Rust 测试。

- `codex-rs/core/src/tools/parallel.rs` 和 `tools/handlers/unified_exec/exec_command.rs`：独立任务与并行能力声明。
- `codex-rs/core/src/state/turn.rs` 和 `session/mod.rs`：多个待审批请求及独立回应通道。
- `codex-rs/tui/src/bottom_pane/approval_overlay.rs`：提交审批决定后推进待审批列表。
- `codex-rs/core/src/unified_exec/process_manager.rs` 和 `session/turn.rs`：进程输出等待、句柄管理与工具结果按序收集。

### 2026-09-06: Shell 域名代理强制执行，macOS 首阶段

状态：macOS 首阶段已完成。全量 326 个测试文件和应用安装包 10 条流程通过，修改保持未提交。

本轮实现：

- 每个受域名限制的 Shell 进程持有独立 HTTP/CONNECT 代理，名单在异步准备前冻结。
- macOS Seatbelt 仅放行该代理的本机 TCP 端口，直连、其他代理端口、UDP 和 Unix socket 仍被系统拒绝。
- 复用公网地址校验，拒绝私网及混合 DNS 答案，并将实际连接固定到已检查的地址。
- Shell 提前返回运行句柄后代理继续存活；进程退出、停止、超时、启动失败及运行时关闭都会回收。进程清理结果不确定时也先撤销网络能力。
- 文件系统 Full Access 与模型提权参数不能丢弃现有域名限制。
- 使用已有 managed policy 配置，不增加依赖或要求用户启动独立代理服务。配置和范围见 [Network Policy](../network-policy.md)。

已验证：真实 Shell 的 HTTP、客户端证书校验的 HTTPS、后台存活、终止回收，以及协议、权限和异常清理回归。

完整平台包 smoke 在 GitHub ripgrep 下载阶段超时，独立连接探测同样失败；按既有质量规范执行的 `--app-only` 安装验收通过。本轮不声称重新验证了远端平台资源下载。

边界与剩余工作：

- Linux 尚缺网络命名空间桥接，Windows 尚缺原生 helper 代理路由；网络已启用且域名列表非空时，Shell 返回 `network_proxy_unavailable`，不会回退成无限制联网。
- 当前仅支持 HTTP 80 与 CONNECT 443。CONNECT 不检查 TLS SNI 或加密后的 HTTP Host，不能限制允许的远端服务自行转发流量。
- 域名代理的跨平台补齐、多客户端服务生命周期、provider 原生搜索完整回放仍未完成。本阶段不代表与 Codex 全面架构对等。

### 2026-09-06: 文件变更工具收敛，暂缓

优先级决定：先推进架构主线；`Edit`、`Patch`、`Write` 的接口收敛仅记录方案，本轮不实施。

- `Edit` 的精确替换能力基本被 `Patch.update` 覆盖。
- `Write` 的创建能力与 `Patch.add` 重叠，但整文件覆盖语义尚未被独立表达；`add` 保持“目标已存在则失败”。
- 候选方案是新调用仅暴露 `Patch`，包含 `add`、`update`、`write`、`delete`、`move`；`write` 明确表示完整内容创建或覆盖。
- 保留旧 `Edit`、`Write` 内部兼容入口，维护历史会话、待审批调用、工具身份和执行指纹；同步处理清单、提示词、预览、历史与回放规则。
- 底层继续复用 `FileMutationRuntime`。后续以模型调用正确率与维护成本评估收敛效果，不把工具数量减少当作完成标准。

当前主线优先推进多客户端服务生命周期。Linux/Windows 原生代理桥接保留待办，需要真实平台验证；当前 macOS 主机尚无 Linux 运行环境。文件工具收敛继续排在这些架构主线工作之后。

### 2026-09-06: 多客户端服务生命周期，嵌入式首阶段

状态：嵌入式首阶段已完成。全量 328 个测试文件和应用安装包 10 条流程通过，修改保持未提交。

- 新增公开 `startBackendService` API，一份 supervised backend 可接受多个独立客户端连接，默认最多 16 个，可配置为 1 至 64 个。
- 宿主指定一个控制端和多个只读端。只读 RPC 使用明确白名单，不能通过参数取得审批、执行、会话切换或关闭权限。
- 断线、异常输入或输出阻塞仅移除对应连接；即使所有客户端退出，后台仍由宿主持有。各客户端请求 ID、响应和输出队列独立。
- 旧控制端已接受的变更 RPC 完成后才释放控制权；正在执行的 turn、Shell 和待审批项继续由原运行时管理，不因接管而重跑。
- 重连通过 bootstrap 获取当前状态，并补发交互队列中当前待答项；不缓存重放已处理审批或历史工具事件。
- 显式 shutdown 接受后立即停止新请求，返回响应并统一关闭后台；发起端立即断开也不会取消关闭。原 stdio 入口沿用服务层并保留 EOF、信号和退出码行为。

验收覆盖：请求 ID 隔离、只读端拒绝、控制权交接、慢连接隔离、关闭竞争及异常清理。真实集成在待审批和命令执行期间分别更换控制端，断言一次命令执行、两次 provider 请求和一条最终工具记录；安装包验证公开 API 的实际接入。

完整平台包 smoke 在沙箱外仍因 ripgrep 下载连接超时失败，随后按既有规范通过 `--app-only` 验收；本项不声称重新验证了远端平台资源下载。

范围和下一步：当前仍是同一宿主进程内的多个客户端、同一时刻一个活动会话。跨进程发现和连接、多个活动会话、订阅过滤及持久事件游标尚未实现。使用方式见 [Gateway API](../gateway.md)。
