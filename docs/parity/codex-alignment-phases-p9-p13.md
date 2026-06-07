# mycli Codex Alignment P9-P13 Phased Plan

本文档把 `mycli` 后续向 Codex-style runtime 靠齐的工作拆成 P9-P13 五个独立阶段。

总方向：

```text
Codex-style runtime kernel is the spine.
Hermes-style provider/cache quirks stay at the provider edge.
```

本计划不复制 Codex 或 Hermes 源码，只参考语义和架构边界。

## Global Guardrails

- 不合入 `main`，除非用户明确说“合吧”。
- 不新增第三方依赖。
- 不做真实外部 provider API 调用。
- 不重写 context assembly。
- 不修改 provider cache request shape。
- 不触碰 compact 后复水实现。
- 不模仿 Codex compact rehydration。
- 不做 ACP、remote agent、swarm、多平台 gateway 产品化。
- 每一期都走 Trellis：research -> PRD -> implementation -> tests -> archive。
- 每一期 commit 使用 Lore protocol。

## Current Worktree

```text
Workdir:
/Users/cosmos/Desktop/mycli/.worktrees/mycli-codex-alignment-p9-runtime-kernel

Branch:
feature/mycli-codex-alignment-p9-runtime-kernel
```

## Phase Order

```text
P9 Runtime Kernel Contract
  -> P10 Tool Runtime Lifecycle Unification
  -> P11 Skill Context Injection Migration
  -> P12 Resume/Fork Runtime Continuity And Compact Boundary Guard
  -> P13 Runtime Diagnostics Productization
```

P9/P10 是地基。P11 依赖统一 tool runtime。P12 只保护 resume/fork/compact 边界，不改 compact 复水。P13 在 runtime contract 稳定后再产品化诊断。

P14/P15 是 P9-P13 之后的 runtime kernel extension：P14 引入 shell
ExecPolicy prefix rules，P15a 把 runtime environment 作为 bounded dynamic
context 暴露给模型，P15b 强化 shell lane execution options，P15c 再把
filesystem/shell/network sandbox policy 作为 effect-profile-driven execution
gate。P15c 必须保持 compact/rehydration 实现未触碰。

P16 已把 runtime enforcement 与 approval pause/resume 接稳。P17-P24 继续沿
runtime kernel 后半段推进：先补 shell process lifecycle 和 backend contract，
再补 background tool runtime、skill runtime finalization、provider quirk
registry、evaluation harness、gateway/ACP readiness、memory/background
maintenance readiness。P17-P24 仍然不触碰 compact/rehydration 实现，不模仿
Codex compact rehydration；gateway、ACP、完整 memory system 和 background
maintenance 只做 readiness 或后续独立项目，不混进 shell/runtime hardening。

---

## P9 Runtime Kernel Contract

### Goal

建立最小 Codex-style runtime kernel contract，让 tool execution 之前必定经过统一策略判断。

### Scope

- 梳理当前 tool execution、approval、sandbox、policy、trace、doctor 链路。
- 定义最小 contract：
  - `ExecutionPolicy`
  - `SandboxProfile`
  - `ApprovalGate`
  - `ToolRuntimeDecision`
  - `ToolRuntimeResult`
- 支持三态 decision：
  - `allowed`
  - `denied`
  - `needs_approval`
- 将 builtin / contributed / MCP / subagent / skill compatibility path 接入同一 policy decision。
- 将 bounded policy decision 写入 trace / ledger / doctor 可读字段。

### Non-goals

- 不重写实际 tool execution 生命周期。
- 不迁移 skill 形态。
- 不改 compact / rehydration。
- 不改 provider cache policy。

### Acceptance

- runtime policy contract 有单测。
- allow / deny / needs_approval 三态有单测。
- denied by policy 不执行工具。
- needs_approval 可持久化到现有 pending approval 语义。
- doctor / trace 能展示 bounded execution policy summary。
- context / subagent / MCP / plugin / hook smoke 不回退。

---

## P10 Tool Runtime Lifecycle Unification

### Goal

让所有 tool-like action 经过一致生命周期，并且可以按 `call_id` 被 trace、doctor、ledger 解释。

### Scope

- 让 `ToolExecutionService` 成为统一入口或统一门面。
- 标准化 lifecycle event：
  - planned
  - policy_checked
  - approval_requested
  - started
  - progress
  - completed
  - failed
  - denied
  - cancelled
  - timed_out
- 覆盖 builtin、contributed、MCP、plugin、hook、subagent、skill compatibility path。
- 标准化 result truncation metadata。
- 标准化 failure/rejection 与普通 tool output 的边界。

### Non-goals

- 不做新的 tool product surface。
- 不增加 long-running worker 系统。
- 不改 provider request shape。
- 不改 compact / rehydration。

### Acceptance

- tool lifecycle 有单测。
- 每次 tool call 可以从 planned 追踪到 terminal state。
- orphan running tool / missing result / malformed lifecycle 能被 doctor 发现。
- denied / rejected 不被伪装成普通 tool failure。
- context / subagent / MCP / plugin / hook smoke 不回退。

---

## P11 Skill Context Injection Migration

### Goal

把 skill 从“每个 skill 默认一个 provider-visible tool schema”的长期心智，迁移到 Codex-style catalog + trigger + context injection + timeline event。

### Scope

- 保留现有 `skill_*` provider-safe tool 作为兼容入口。
- 新增或整理 skill catalog 作为 stable context/capability metadata。
- 只有被触发或显式激活的 skill instructions 才进入 active context。
- skill activation 写入 timeline / ledger。
- 已激活 skill instructions 需要可 replay，避免后续 skill 文件删除导致历史 turn 丢语义。
- 减少 provider-visible tool schema 随 skill 数量变化而造成的 prefix-cache 失效。

### Non-goals

- 不删除现有 skill compatibility tool。
- 不实现完整 marketplace / plugin registry。
- 不改 compact / rehydration。
- 不改 provider adapter。

### Acceptance

- 新增 skill 不默认改变 provider tool schema。
- activated skill instructions 可 replay。
- 删除 skill 文件后，已激活 turn 的历史语义仍可用。
- skill activation 有 trace / ledger 记录。
- prefix-cache stable hash 不因未激活 skill 数量变化而频繁失效。

---

## P12 Resume/Fork Runtime Continuity And Compact Boundary Guard

### Goal

补齐 resume/fork 的 runtime continuity，并给 compact/rehydration 建立边界守护测试，确保后续工作不会误伤现有复水逻辑。

### Scope

- 明确 resume/fork 使用 canonical timeline 和 runtime ledger 的读取边界。
- 明确 pending approval、running/interrupted tool、runtime policy snapshot 在 resume/fork 后的恢复规则。
- 明确 fork lineage 不污染 parent transcript。
- 为 compact/rehydration 增加只读 contract tests：
  - 不改复水实现。
  - 不模仿 Codex 复水。
  - 只验证现有 compact 后 active context、stable prefix、provider-private state filtering 不回退。
- 在文档中说明 compact 是被保护边界，不是本阶段改造对象。

### Non-goals

- 不修改 compact 后复水逻辑。
- 不重写 compact engine。
- 不实现 provider-specific compact engine。
- 不把 Codex compact rehydration 迁进 mycli。
- 不改 request shape 分层。

### Acceptance

- resume/fork runtime continuity 有单测。
- pending approval resume 行为有单测。
- fork 不污染 parent transcript。
- compact/rehydration contract regression tests 通过，且 diff 不触碰现有复水核心实现。
- trace / doctor 能解释 resume/fork runtime continuity 状态。

---

## P13 Runtime Diagnostics Productization

### Goal

让 runtime kernel 的执行策略、sandbox、approval、tool lifecycle 像 cache policy 一样可诊断、可 dry-run、可长期回归。

### Scope

- doctor 增加 runtime diagnostics：
  - execution policy summary
  - sandbox profile summary
  - approval gate state
  - tool lifecycle integrity
  - denied / needs_approval / disabled-by-policy 区分
- trace export 增加 bounded runtime policy fields。
- dry-run 展示：
  - exposed tools summary
  - policy decision summary
  - sandbox lane
  - approval lane
  - provider request shape summary
- 标准化 redaction boundary：
  - 不输出 raw prompt
  - 不输出 raw tool output
  - 不输出 secret
  - 不输出完整 provider key
  - 不输出完整 `prompt_cache_key`

### Non-goals

- 不做 UI/TUI 产品化。
- 不做真实 provider diagnostics call。
- 不改 compact / rehydration。
- 不新增 telemetry backend。

### Acceptance

- doctor runtime diagnostics 有单测。
- trace bounded runtime fields 有单测。
- dry-run runtime diagnostics 有单测。
- provider-free smoke 覆盖 runtime policy diagnostics。
- ruff、mypy、pytest 全量通过。

---

## Per-phase Quality Gate

每一期结束前至少运行：

```text
uv run ruff check src tests evaluation
uv run mypy src/mycli
uv run pytest -q
```

如果该期触碰 context/subagent/MCP/plugin/hook 任一链路，还需要运行对应 smoke。

每一期最终报告包含：

- 分支
- commits
- 完成内容
- 测试结果
- 是否触碰 compact/rehydration，以及证明
- 剩余 Codex runtime 差距
- 下一步建议
