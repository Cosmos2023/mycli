# mycli TUI Experience Blueprint

本文档定义 `mycli` 如何学习 Hermes Agent、Codex 和 Claude Code 的 TUI / agent 使用体验，并把这些经验整理成一条可执行的 TUI 改造路线。

目标不是复制某一个产品的外观，而是建设一个 **可信、安全、可恢复、可观察、低摩擦的本地 coding-agent 工作台**。

核心判断：

- `mycli` 功能层可以暂缓扩张，接下来优先补齐 TUI 体验。
- Python runtime 继续作为事实来源，Node / Ink 负责终端交互。
- 第一阶段不要追求花哨，要先做到专业、稳定、可控。
- 视觉要比当前更有层次，但不能变成花花绿绿的装饰界面。

---

## 目录

1. 产品定位
2. 当前基础
3. 参考对象
4. 目标架构
5. 核心体验规则
6. 视觉设计系统
7. Slash Command 体系
8. Hermes Command Gap Backlog
9. Implementation Roadmap
10. UX Priority Matrix
11. Acceptance Markers
12. What Not To Do First
13. One-line Strategy

---

## 1. 产品定位

`mycli` 的 TUI 应该像一个本地 coding-agent 工作台：

```text
trust -> submit -> stream -> tools -> approval -> diff -> tests -> summary -> resume
```

用户进入 TUI 后，应始终知道：

- 当前 workspace 是否可信。
- agent 当前是 idle、thinking、reading、editing、testing，还是 waiting approval。
- 哪些文件被读了、改了、测试了。
- 哪些动作需要用户批准。
- 当前 session 是否可恢复，如何恢复。
- 上下文和 token 压力处于什么状态。

### 1.1 分层原则

推荐边界：

```text
Python runtime
  session / tools / approvals / memory / model calls / traces

JSON-RPC gateway
  typed request + event contract over stdio

Node Ink TUI
  transcript / composer / overlays / status / slash commands

terminal hygiene
  alternate screen / Ctrl+C / resize / cleanup / non-TTY fallback
```

原则：

- Python runtime 是事实来源，负责 agent、工具、安全策略、session、memory、diagnostics。
- Node / Ink 只负责屏幕呈现、输入、overlay、状态栏和用户交互。
- 双方通过稳定 JSON-RPC request/event contract 通信。
- 所有高风险动作必须经过 runtime enforcement，不能只依赖模型 prompt。
- 默认 UI 保持干净，细节通过 expand、pager、verbose mode 展开。

---

## 2. 当前基础

`mycli` 已经具备 Node TUI 的基础骨架：

- Python gateway：`src/mycli/cli/node_tui/gateway.py`
- JSON-RPC codec：`src/mycli/cli/node_tui/protocol.py`
- typed gateway contract：`src/mycli/domain/runtime/gateway_contract.py`
- Node / Ink app：`tui/node/src/app/*`
- Node reducer/state：`tui/node/src/state/*`
- typed TS protocol：`tui/node/src/protocol/*`
- approval、clarify、tool lifecycle、scripted smoke 测试已存在

因此改造方向应是 **强化现有 Node TUI**，不是重开一套。

当前主要差距：

- 真实 full-screen Node TUI 入口还不够产品化。
- 视觉层级偏弱，状态、工具、正文之间区分不够。
- slash command discoverability 不够强。
- session lifecycle、resume、fresh start 规则需要更清晰。
- trust / approval / diff-first coding workflow 需要进一步产品化。
- resize、Ctrl+C、terminal cleanup、gateway crash diagnostics 需要成为基础能力。

---

## 3. 参考对象

### 3.1 Hermes Agent

Hermes TUI 值得学习的是架构纪律和长 session 操控能力，不是表面装饰。

Hermes 的核心模型：

```text
hermes --tui
  -> Node Ink frontend
    -> Python tui_gateway
      -> AIAgent / tools / sessions / slash / approvals
```

可以借鉴：

- TypeScript 拥有屏幕，Python 拥有真实 agent 状态。
- Runtime 活动拆成事件，TUI 消费事件，不猜内部状态。
- 主布局稳定：`TranscriptPane` + `PromptZone` + `ComposerPane / StatusLine`。
- 工具活动默认折叠，只展示 compact trail。
- slash command 覆盖 model、session、context、debug、visual、runtime controls。
- 通过 semantic theme tokens、Unicode glyphs、box drawing、status ticker、floating overlays 构造视觉层次。

### 3.2 Codex / Claude Code

Codex 和 Claude Code 值得学习的是安全感和 coding workflow：

- workspace trust gate
- clear approval / permission UX
- stable turn lifecycle
- todo / plan visibility
- diff-first coding UX
- interrupt reliability
- session resume
- slash completion
- context transparency
- terminal hygiene

这些体验会让用户敢把 TUI 当成真正的 coding surface，而不是一个聊天壳。

---

## 4. 目标架构

### 4.1 Runtime Contract

保留当前方法名即可，不必强行改成 Hermes 命名，但语义要清晰。

基础 request：

```text
session.bootstrap       # initialize TUI runtime
transcript.load         # load visible transcript
turn.submit             # submit user turn
turn.interrupt          # interrupt current turn
approval.respond        # resolve approval
clarify.respond         # resolve clarification
completion.slash        # slash completion
completion.path         # path completion
command.run             # slash command fallback
status.inspect          # inspect current runtime status
trace.export            # diagnostics
session.list/resume     # session continuity
shutdown                # graceful teardown
```

建议新增 request：

```text
terminal.resize
workspace.trust.status
workspace.trust.set
diff.current
changes.list
command.catalog
logs.tail
doctor.run
model.list
model.set
context.compact
session.title
session.export
clipboard.copy
```

### 4.2 Event Streams

应保留并强化：

```text
runtime.ready
status.changed
status.update
turn.started
turn.status
turn.completed
turn.failed
turn.interrupted
message.delta
message.complete
reasoning.delta
thinking.delta
tool.start
tool.progress
tool.complete
tool.failed
approval.request
approval.respond
clarify.request
clarify.respond
gateway.error
session.changed
```

建议新增：

```text
workspace.trust.required
workspace.trust.changed
diff.summary
context.updated
compact.completed
logs.tail
terminal.resized
queue.changed
model.changed
statusbar.changed
```

### 4.3 Node App Shape

推荐组件所有权：

```text
RuntimeApp
  GatewayProvider
  AppLayout
    TranscriptPane
      WelcomePanel
      Transcript
      StreamingAssistant
      ToolActivityRows
    PromptZone
      TrustPrompt
      ApprovalPrompt
      ClarificationPrompt
      ConfirmPrompt
    ComposerPane
      QueuedMessages
      CompletionPopup
      InputBox
      StatusLine
```

### 4.4 State Shape

推荐顶层 TUI state：

```ts
type ShellState = {
  sessionId: string | null
  workspace: string
  trust: TrustState
  mode: "read_only" | "plan" | "agent" | "yolo"
  transcript: TranscriptItem[]
  liveStatus: LiveStatus | null
  liveReasoning: LiveReasoning | null
  liveTools: ToolSummary[]
  pendingApproval: ApprovalRequest | null
  pendingClarification: ClarifyRequest | null
  completion: CompletionState
  queuedInputs: string[]
  status: RuntimeStatus
  theme: ThemeTokens
}
```

### 4.5 Terminal Hygiene

专业 TUI 的底线：

- alternate screen
- 退出恢复 cursor/raw mode
- resize 不崩
- Ctrl+C lifecycle 稳定
- stdout/stderr 不污染 UI
- non-TTY fallback 到普通 CLI
- gateway crash 显示诊断和恢复建议
- Ctrl+Z / suspend 后能恢复终端状态
- logging 写文件或 in-app log pane，不写 stdout

---

## 5. 核心体验规则

### 5.1 Workspace Trust

首次进入 workspace 时必须问：

```text
Do you trust this folder?
```

信任状态影响能力：

- 未信任：只读、普通聊天、查看文件。
- 已信任：允许 shell、写文件、hooks、plugins、项目指令参与自动执行。
- 可撤销：`/trust`, `/untrust`, `/trust status`。

信任对象应是 git root 或 cwd，而不是单个 turn。

### 5.2 Approval / Permission UX

所有高风险动作都应有明确 approval：

- shell command
- file write / edit
- network access
- dependency install
- destructive command
- git reset / checkout / clean
- hooks / plugins / project scripts

Approval UI 应展示：

- 要执行什么
- 在哪个 cwd
- 为什么危险
- 可选项：approve once / reject / allow session
- stable decision id

拒绝后 session 应继续，不应崩溃。

### 5.3 Turn Lifecycle

每个 turn 应有明确生命周期：

```text
idle
  -> submitted
  -> planning / thinking
  -> tool running
  -> waiting approval
  -> editing
  -> testing
  -> summarizing
  -> completed / failed / interrupted
```

UI 不应只显示一个 spinner。用户需要知道 agent 在做什么。

### 5.4 Interrupt Reliability

Ctrl+C 行为必须确定：

```text
overlay active -> cancel overlay
turn running -> interrupt current turn
input not empty -> clear input
idle -> exit
```

Interrupt 后 transcript 应保留 partial response 或系统行：

```text
[interrupted]
```

### 5.5 Tool Failure Display

Tool 执行失败时，TUI 的目标不是“把 stderr 全量刷红”，而是让用户立刻知道：

- 哪个 tool 失败。
- 失败发生在什么阶段。
- 是否已经产生副作用。
- 失败原因是什么。
- 用户或 agent 下一步能做什么。

失败行应保持 compact，默认只显示摘要：

```text
x Bash pytest -q · exit 1 · 14s
  3 failed, 41 passed · details: Enter · logs: /logs
```

展开后再显示结构化细节：

```text
x Tool failed: Bash
  command   pytest -q
  cwd       /Users/cosmos/Desktop/mycli
  exit      1
  duration  14s
  phase     testing

  stderr
    tests/unit/test_tui.py::test_status_line FAILED

  next
    /retry       retry last user turn
    /logs        inspect full output
    /changes     inspect current file changes
```

不同失败类型应有不同文案：

| Failure type | Compact label | Required detail |
| --- | --- | --- |
| Shell exit non-zero | `exit N` | command, cwd, duration, stderr tail, full log pointer |
| Timeout | `timeout Ns` | command, cwd, elapsed, whether process was killed |
| Approval denied | `denied` | requested action, decision id, no side effect note |
| Tool unavailable | `unavailable` | tool name, provider/source, suggested setup command |
| Permission blocked | `blocked` | policy/trust/sandbox reason, command to change policy if safe |
| Parse/protocol error | `protocol error` | method/event name, request id, gateway log pointer |
| Partial failure | `partial` | what succeeded, what failed, files touched |

Rules:

- Use `x` plus error color, but never rely on color alone.
- Keep stdout/stderr folded by default; show tail only when useful.
- Always preserve full output in `/logs` or an expandable detail pane.
- Mark side effects explicitly: `no files changed`, `2 files changed before failure`, or `unknown side effects`.
- If the agent can recover, show the next action in assistant prose, not only in the tool row.
- A failed tool does not automatically mean the whole turn failed; the turn can continue to diagnose or fix.

### 5.6 Session Continuity

`mycli` 应支持：

- 自动保存 session
- `/resume` picker
- `/sessions` 列表
- 退出后打印 resume 命令
- 崩溃后恢复 suspended turn / pending approval

默认启动策略必须明确：

- 普通 `mycli --tui` / `mycli` 启动应创建全新的 session。
- 只有显式 `mycli resume`、`mycli --resume <id>`、`mycli --session <id>` 或 TUI 内 `/resume` 才能接回旧 session。
- 启动页可以展示最近 sessions，但不能自动 attach 到最近一次会话。
- pending approval、suspended turn、crashed turn 只能在显式 resume 后恢复，避免用户以为自己在新会话里却继承了旧上下文。
- 可以预留 `display.tui_auto_resume_recent` 配置，但默认值必须是 `false`，并且启动时要明显提示。

### 5.7 Context Transparency

用户需要知道 agent 看到了什么：

- `/context` 展示当前上下文来源。
- AGENTS.md / project instructions / skills / memory 分区显示。
- 显示哪些文件进入 prompt。
- 显示 token budget。
- 明确哪些内容被压缩、省略或降级。
- 在上下文压力变高时提示 `/compact`。

### 5.8 Busy Input Mode

用户在 turn running 时继续输入，应有明确策略：

- `queue`：排队到下个 turn。
- `steer`：注入当前 turn。
- `interrupt`：打断当前 turn 后发送新消息。

第一阶段至少实现 `queue`，并让状态栏显示 queued count。

### 5.9 Pasting / Large Input

需要支持：

- bracketed paste
- 大段 paste 折叠成 `[pasted 240 lines]`
- `@file` 引用文件
- 文件路径粘贴 / 拖入识别
- pasted content 不撑爆输入框

### 5.10 Diff-first Coding UX

每次文件修改后，用户应能快速看到：

- touched files
- diff summary
- additions/deletions
- tests run
- not tested
- rollback / undo path

推荐命令：

- `/changes`
- `/diff`
- `/undo`
- `/checkpoint`

---

## 6. 视觉设计系统

当前 `mycli` TUI 的问题不是“颜色不够多”，而是视觉层级还不够强。

目标感受：

```text
restrained, professional, information-dense,
with strong visual hierarchy and a recognizable mycli identity.
```

也就是：

```text
Claude Code / Codex clarity
  + Hermes-like identity and live activity
  - unnecessary decoration
```

### 6.1 Layout

采用稳定三段布局：

```text
┌──────────────── Transcript ────────────────┐
│ user prompts                               │
│ assistant prose                            │
│ folded tool activity                       │
│ system notices                             │
├──────────────── PromptZone ────────────────┤
│ approval / clarify / confirm overlays      │
├──────────────── Composer ──────────────────┤
│ input + completion + queue + status line    │
└────────────────────────────────────────────┘
```

窄屏 fallback：

- 只保留 transcript + composer。
- PromptZone 变成 modal overlay。
- status line 压缩成一行。
- 长路径中间截断。

### 6.2 Glyph System

给 `mycli` 一个小而稳定的视觉身份：

```text
◆ mycli        app / welcome mark
❯             user prompt
●             running tool or activity
✓             completed action
!             warning / approval required
x             failed action
▍             streaming cursor
```

规则：

- 符号要稳定，不要每个地方都换。
- 避免大量 emoji。
- 不要每条消息都标 `USER` / `ASSISTANT`。
- 让 prompt glyph、缩进、spacing 承担 transcript 节奏。

### 6.3 Theme Tokens

组件不要散落 raw colors，应使用 semantic tokens：

```ts
accent
text
muted
subtle
border
success
warning
error
info
prompt
completionBg
completionActiveBg
diffAdded
diffRemoved
```

建议 theme presets：

- `graphite`：专业 dark default。
- `deep-teal`：branded dark theme。
- `amber`：Hermes-inspired warm theme。
- `mono`：minimal / low-color mode。
- `high-contrast`：accessibility-oriented mode。

颜色纪律：

- 一个主 accent。
- 一个 warning color。
- 一个 error color。
- 一个 success color。
- muted gray 用于 secondary data。
- 不做 rainbow transcript。
- 默认不使用大面积彩色背景。
- 支持 `NO_COLOR` 和高对比主题。

### 6.4 Transcript Rows

目标 transcript shape：

```text
❯ Help me inspect the TUI gateway.

The gateway already has a typed JSON-RPC contract...

  ● Read src/mycli/cli/node_tui/gateway.py
  ✓ Grep "turn.submit" · 6 matches
  ✓ Edit tui/node/src/app/App.tsx · +32 -6
  x Bash pytest -q · exit 1 · 14s · 3 failed
```

规则：

- User rows 要明显但紧凑。
- Assistant prose 保持干净，不默认加重边框。
- Tool rows 默认缩进 + 折叠。
- Failed tool rows 使用 `x`、错误语义色和明确原因，例如 `exit 1`、`timeout 30s`、`denied`。
- Failed tool rows 不应把 stderr 直接铺满 transcript；默认显示一行摘要和详情入口。
- System/error rows 默认 muted，除非需要用户行动。
- Turn separator 要轻，不要每轮都是大 card。

Tool row 状态建议：

```text
● Bash pytest -q                         running · 8s
✓ Bash pytest -q · exit 0 · 14s           success
x Bash pytest -q · exit 1 · 14s           failed · details: Enter
! Bash rm -rf dist                        waiting approval
○ Bash npm install                        queued
```

### 6.5 Status Line

Status line 是质量锚点，应承担大部分 ambient context。

Running:

```text
● Thinking 12s · read -> edit -> pytest       gpt-5.4 high · 42k/128k · trusted · feature/tui
```

Idle:

```text
Ready · gpt-5.4 high · 18k/128k · trusted · /Users/.../mycli
```

Approval:

```text
! Waiting approval · Bash write access        gpt-5.4 · ask · trusted
```

规则：

- 尽量保持一行。
- segment width 稳定，避免 jitter。
- cwd、model、session label 可预测截断。
- mode、trust、sandbox 在相关时必须可见。

### 6.6 Overlays

Overlays 应该像聚焦工具，而不是原始文本 dump。

Slash completion:

```text
╭ Commands ─────────────────────────────╮
│ › /context   show active context       │
│   /diff      show current changes      │
│   /doctor    diagnose environment      │
╰───────────────────────────────────────╯
```

Approval:

```text
! Approval required
  Bash: rm -rf dist
  Risk: destructive file operation

  1 Allow once   2 Reject   3 Allow similar this session
```

Model picker:

```text
╭ Model ────────────────────────────────╮
│ › gpt-5.4        frontier · high       │
│   gpt-5.4-mini   standard · fast       │
╰───────────────────────────────────────╯
```

规则：

- border 只用于 modal tools 和 focused popups。
- overlay copy 短、明确、可操作。
- keyboard-first，mouse 可选。
- 长输出进入 pager。

### 6.7 Welcome Panel

Welcome panel 不是 marketing card，而是 workspace summary：

```text
◆ mycli
  workspace  /Users/cosmos/Desktop/mycli
  branch     feature/mycli-hermes-parity-integration
  trust      trusted
  model      gpt-5.4
  mode       ask

  /help commands   /context sources   /doctor checks
```

规则：

- 只在 session 没有 conversation content 时显示。
- 第一个 user turn 后自动隐藏。
- 窄屏时缩短。
- 不占用永久垂直空间。

### 6.8 Width Rules

所有布局宽度必须 terminal-cell aware：

- 使用 `string-width` 或同等能力。
- CJK、emoji、box drawing 都要按 cell width 处理。
- path 用 middle truncation。
- list/table cell truncate，不要任意 wrap。
- 不要假设 `.length === display width`。

---

## 7. Slash Command 体系

Slash commands 是 power-user surface。它的目标不是“命令越多越好”，而是让用户在不中断 flow 的情况下控制 session、runtime、context 和 TUI。

必须支持：

- completion
- alias
- description
- category
- fuzzy command palette
- typo suggestion
- long output pager

### 7.1 mycli 已有命令

`mycli` 已经有一组基础命令：

```text
/help
/skills
/tools
/toolsets
/logs
/trace
/trace-jsonl
/usage
/context
/status
/sessions
/resume
/fork
/changes
/undo
/view
/theme
/memory
/subagents
/hooks
/plugin
/bashes
/search
/stats
/session
/session-maintenance
/quit
/clear
```

这些命令说明基础 runtime 和诊断面已经存在。接下来优先补 TUI control 和长 session 操控。

### 7.2 推荐目标命令集

Session：

```text
/sessions
/resume
/title
/history
/export
/fork
/retry
/queue
/clear
/quit
```

Runtime / diagnostics：

```text
/status
/usage
/context
/compact
/logs
/trace
/doctor
/events
/reload
```

Coding workflow：

```text
/changes
/diff
/undo
/checkpoint
/test
```

Model / behavior：

```text
/model
/provider
/reasoning
/fast
/approvals
/trust
```

TUI controls：

```text
/theme
/view
/details
/statusbar
/redraw
/mouse
/terminal-setup
/copy
/paste
```

Tools / extensions：

```text
/skills
/tools
/toolsets
/hooks
/plugin
/subagents
/reload-skills
/reload-mcp
```

### 7.3 Naming Rules

- Prefer existing `mycli` vocabulary: `/fork` over adding `/branch`, `/theme` over `/skin`。
- Add aliases only for high-frequency commands: `/q`, `/ctx`, `/sb`。
- Hidden/dev commands 可以存在，但普通 `/help` 默认只展示 coding 用户需要的命令。
- Mutating commands must echo the effective value: `statusbar: compact`, `busy mode: queue`。
- Slash command output should be structured and page-able, not raw dump。

---

## 8. Hermes Command Gap Backlog

Hermes 的 TUI 命令更完整，尤其覆盖长 session 操控、视觉配置和运行中控制。下面按 `mycli` 应该补齐的优先级整理。

### 8.1 P1 - Add Soon

这些命令直接影响日常 coding-session 舒适度。

| Command | Hermes behavior | mycli state | Recommendation |
| --- | --- | --- | --- |
| `/model` | Switch model/provider for the current session. | Missing as slash command. | Add a model picker overlay plus typed fallback. Alias `/provider` only if provider switching is real. |
| `/compact` or `/compress` | Manually compress conversation context. | `/context` and `/usage` exist, but no manual compact command. | Prefer `/compact [focus]`; keep `/compress` as alias if desired. Show before/after retained context. |
| `/retry` | Retry the last user message. | Missing. | Add after session store can identify the last completed user turn. Preserve original prompt and mark retry in transcript. |
| `/queue` | Queue a prompt for the next turn while agent is busy. | Busy queue is planned, command missing. | Add `/queue <prompt>` plus alias `/q`; later add queued-message editor. |
| `/title` | Set current session title. | Session metadata exists conceptually, command missing. | Add `/title [text]`; blank value can auto-generate from first task. |
| `/copy` | Copy latest assistant response to clipboard. | Missing. | Add `/copy [turn]` with OSC 52 or platform clipboard fallback. |
| `/history` | Show conversation history. | `/sessions` exists, transcript pager not explicit. | Add current-session history pager with search, jump to turn, copy/export actions. |
| `/export` or `/save` | Save current conversation. | Missing. | Prefer `/export [markdown|jsonl]`; `/save` can be alias. |
| `/statusbar` | Toggle context/model status bar. | `/view` exists, but no status-line control. | Add `/statusbar [on|off|compact|full]` and alias `/sb`. |
| `/details` | Toggle detail visibility for tools/reasoning/events. | `/view default|verbose|focus` exists. | Either alias `/details` to `/view`, or support `/details tools|reasoning|events on|off`. |

### 8.2 P2 - Add After Core TUI Is Stable

这些是 polish 和 recovery 命令，不要求新 agent intelligence，但要求 terminal/runtime contract 稳定。

| Command | Hermes behavior | mycli state | Recommendation |
| --- | --- | --- | --- |
| `/redraw` | Force full UI repaint after terminal drift. | Missing. | Add after alternate-screen and resize handling are real. |
| `/mouse` | Toggle mouse/scroll support. | Missing. | Add `/mouse on|off|status` only after mouse wheel support exists. |
| `/terminal-setup` | Help configure terminal features. | Missing. | Add diagnostics for truecolor, tmux, OSC 52, bracketed paste, image support. |
| `/paste` | Attach clipboard image or handle clipboard content. | Missing. | Start with text paste diagnostics; image clipboard can wait. |
| `/image` | Attach a local image file. | Missing. | Add only if runtime supports multimodal input. Preview path, size, type before submit. |
| `/background` | Run a prompt in the background. | Missing. | Add after foreground turn lifecycle, interrupt, and approval routing are stable. |
| `/stop` | Stop running background processes. | Missing. | Expose for spawned/background tasks; do not confuse with turn interrupt. |
| `/reload` | Re-read env/config in running gateway. | Missing. | Add `/reload config|env|all`; show what changed. |
| `/reload-skills` | Re-scan skills without restarting. | Missing. | Add if skill discovery is cached. Invalidate completion metadata too. |
| `/reload-mcp` | Reload MCP servers from config. | Missing unless MCP becomes runtime capability. | Defer until MCP exists; keep command name reserved. |
| `/setup` | Run setup/onboarding checks. | Missing as slash command. | Map to `/doctor tui` and `/doctor runtime`, or add guided first-run overlay. |

### 8.3 P3 - Defer Or Optional

这些 Hermes 命令依赖较大的产品方向，暂时不要阻塞主 TUI。

| Command | Hermes behavior | Recommendation |
| --- | --- | --- |
| `/browser` | Connect live browser tools over CDP. | Defer until browser automation is core. |
| `/voice` | Voice input / TTS control. | Defer; setup and dependency cost高。 |
| `/agents` / `/tasks` | Spawn-tree dashboard and controls. | `mycli` has `/subagents`; build dashboard only after delegation state is mature. |
| `/replay` / `/replay-diff` | Replay completed spawn trees and compare them. | Defer unless `mycli` records structured agent traces. |
| `/rollback` | List/restore filesystem checkpoints. | Useful, but requires reliable snapshots. Consider `/checkpoint` first. |
| `/yolo` | Skip dangerous command approvals. | Avoid this name by default. If needed, use `/approvals yolo` with loud warnings. |
| `/reasoning` | Manage reasoning effort and display. | Add later as model/session settings. |
| `/fast` | Toggle provider fast/priority mode. | Add only if providers expose meaningful fast-mode settings. |
| `/personality` | Set assistant persona. | Defer unless `mycli` introduces profiles. |
| `/skin` / `/indicator` | Theme and busy indicator controls. | `/theme` exists; add indicator only after visual system stabilizes. |
| `/update` | Self-update Hermes. | Defer; package managers handle this better early on. |
| `/heapdump` / `/mem` | Debug Node memory. | Keep hidden under dev/debug help. |
| `/fortune` | Fun output. | Skip for professional coding flow. |

---

## 9. Implementation Roadmap

### P0 - Foundation Experience

Goal: make Node TUI real, safe, and usable.

1. True Node TUI entry
   - Replace scripted-only default entry with real Ink app.
   - Keep scripted client for tests.
   - Use `/dev/tty` for UI and stdio for JSON-RPC.

2. Terminal cleanup
   - alternate screen
   - graceful exit
   - Ctrl+C lifecycle
   - non-TTY fallback
   - gateway crash diagnostics

3. Workspace trust gate
   - trust status RPC
   - blocking TrustPrompt overlay
   - runtime enforcement before shell/write/hooks/plugin

4. Approval overlay hardening
   - stable decision id
   - approve once / reject / allow session
   - rejection is terminal turn state, not crash

5. Three-pane layout
   - TranscriptPane
   - PromptZone
   - ComposerPane
   - compact StatusLine

6. Tool folded rows
   - running/done/failed compact rows
   - failed rows show exit/timeout/denied/unavailable reason
   - stderr/stdout folded behind details or `/logs`
   - expandable details later

### P1 - Coding Workflow

Goal: make day-to-day coding tasks feel close to Codex / Claude Code.

1. Slash command catalog
   - `/help`
   - `/model`
   - `/context`
   - `/usage`
   - `/status`
   - `/trust`
   - `/diff`
   - `/changes`
   - `/undo`
   - `/retry`
   - `/queue`
   - `/compact`
   - `/logs`
   - `/doctor`

2. Completion
   - slash display/meta
   - path completion
   - stable popup above composer
   - fuzzy command palette later

3. Session continuity
   - `/sessions`
   - `/resume`
   - `/title`
   - exit resume hint
   - plain startup always creates a fresh session unless resume is explicit

4. Diff and changes
   - `/diff`
   - `/changes`
   - per-turn changed files
   - final summary includes tests and risks

5. Busy input queue
   - queue while running
   - drain after turn settles
   - queued count visible in status line

6. Context transparency
   - `/context`
   - token budget
   - source sections
   - compact warning

### P2 - Mature TUI Polish

Goal: improve long-session comfort and advanced workflows.

1. Resize and sticky scroll
2. Large paste collapse
3. Markdown renderer improvements
4. Tool detail expansion
5. Mouse wheel support
6. Optional session picker overlay
7. Subagent / task dashboard
8. Transcript history and export
   - `/history`
   - `/copy`
   - `/export`
9. TUI runtime controls
   - `/redraw`
   - `/statusbar`
   - `/details`
   - `/terminal-setup`

### P3 - Advanced / Optional

Only after P0-P2 are stable:

- browser automation surface
- voice / TTS
- replay / replay-diff
- full rollback snapshot UI
- perf pane
- advanced markdown/table/math
- richer mouse selection

---

## 10. UX Priority Matrix

Use this matrix to keep implementation order disciplined.

| Priority | Experience | Why it matters |
| --- | --- | --- |
| P0 | Workspace trust | Prevents untrusted project content from driving risky behavior. |
| P0 | Approval overlay + stable ids | Makes shell/write/destructive actions understandable and recoverable. |
| P0 | True Node TUI entry | Moves from smoke client to real product surface. |
| P0 | Terminal cleanup | Prevents broken terminal state after crashes or Ctrl+C. |
| P0 | Interrupt lifecycle | Gives users immediate control over long or wrong turns. |
| P0 | Folded tool rows | Keeps transcript readable during real coding tasks. |
| P0 | Tool failure display | Makes failed commands diagnosable without flooding the transcript. |
| P0 | Gateway diagnostics | Makes startup/runtime failures actionable. |
| P1 | Slash catalog + completion | Makes features discoverable without documentation. |
| P1 | Model picker | Lets users change model/provider without restarting. |
| P1 | Context transparency | Lets users trust what the agent is using as input. |
| P1 | Manual compact | Gives user agency before hidden context loss. |
| P1 | Diff / changes / undo | Gives confidence around file mutations. |
| P1 | Fresh-session default | Prevents accidental inheritance of old context. |
| P1 | Session resume | Makes long tasks and crash recovery practical. |
| P1 | Retry / queue / title | Makes long sessions controllable from composer. |
| P2 | Large paste collapse | Improves comfort for real-world prompts and logs. |
| P2 | Copy / history / export | Makes finished work reusable and auditable. |
| P2 | Redraw / terminal setup / statusbar | Improves terminal recovery and personalization. |
| P2 | External editor | Makes long instructions ergonomic. |
| P2 | Transcript search / focus mode | Helps long-session navigation. |
| P3 | Mouse support | Useful but should not be required. |
| P3 | Subagent dashboard | Valuable after delegation is mature. |
| P3 | Browser / voice / replay | Valuable only if those product areas become core. |
| P3 | Perf pane | Useful for tuning after the UI is real. |

---

## 11. Acceptance Markers

The TUI experience is good enough for the first serious milestone when:

- Starting `mycli --tui` opens a real TUI, not a scripted smoke client.
- Plain startup creates a fresh session.
- Explicit resume restores prior session state.
- A new workspace asks for trust before risky execution.
- User can submit a prompt, see streaming response, see tool rows, and get a final answer.
- Failed tools show compact failure rows with reason, side-effect status, and details/logs path.
- Shell/write actions require approval with stable decision ids.
- Ctrl+C reliably cancels overlay, interrupts turns, clears input, or exits.
- `/help`, `/status`, `/context`, `/logs`, `/doctor` work.
- `/model`, `/compact`, `/retry`, `/queue`, `/sessions`, `/resume`, `/title` are implemented or tracked as the next command milestone.
- A failed gateway startup shows actionable diagnostics.
- Exiting restores terminal state.
- Tests cover gateway protocol, reducer state, approval, interrupt, tool lifecycle, and scripted Node smoke.

---

## 12. What Not To Do First

Avoid early complexity:

- Forking Ink
- Full Hermes-style custom ScrollBox
- Mouse selection overlay
- Sidecar WebSocket mirror
- Complete Markdown/table/math parser
- Complex banner art
- Multi-live-session switcher
- Full subagent dashboard
- Browser and voice integration
- Fun/charm commands that do not improve coding flow

These are mature-product features. First make the primary loop reliable.

---

## 13. One-line Strategy

`mycli` should use Hermes Agent's architecture discipline, Codex/Claude Code's safety and workflow expectations, and its own Python runtime strengths to build a local-agent TUI where:

```text
runtime truth stays in Python,
user experience lives in Node/Ink,
and every risky action is visible, reversible, and recoverable.
```
