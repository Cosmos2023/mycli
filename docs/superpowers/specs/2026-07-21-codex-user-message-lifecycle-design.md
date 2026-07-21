# Codex 风格 User Message 生命周期设计

## 状态

2026-07-21 已确认。

本文档取代
`2026-07-20-codex-style-steering-queue-semantic-alignment-design.md`
中“后端持久化用户队列是唯一事实来源”的设计决定。旧文档继续保留，用于说明
当前实现为何包含 `SessionQueueCoordinator`、revision snapshot 和
`rejected_steer` 后端调度器。

本文档只调整用户消息、steering 和 follow-up 的生命周期。Shell、工具输出、
审批、clarification、task notification 和 session transcript 的其他设计不在本次
范围内。

## 目标

让 mycli 的用户消息行为与 Codex 保持同一套可观察语义：

- 普通输入、当前 turn steering 和 turn 结束时剩余的 steering 使用统一提交路径。
- Runtime 正常存活或正常结束 turn 时，已被 backend 接受的用户消息最终写入
  conversation、history 和 TUI transcript。
- steering 在当前 regular turn 的 mailbox 中消费，而不是由 backend 创建第二个 turn。
- TUI 本地持有 pending steer、rejected steer 和 queued follow-up。
- 未被 backend 接受的本地队列不写 session history，也不跨进程重启恢复。
- 实时 TUI 与 `/resume` 都由相同的 committed user-message 事件语义驱动。
- 内部中断标记可以进入模型恢复上下文，但不能成为可见 UserMessage。

## 非目标

- 逐行翻译 Codex Rust 实现。
- 改变模型 provider、tool-call 顺序或 DeepSeek 多 tool-call 行为。
- 持久化 TUI 编辑器草稿、pending steer 或 Tab follow-up。
- 在已发出的 provider HTTP 请求中途修改请求体。
- 删除 backend 用于 task notification 等内部消息的运行时投递能力。
- 重写完整 session storage 或历史文件格式。

## Codex 参考语义

Codex 将用户消息视为生命周期事件，而不是必须与 assistant 回复成对存在的聊天
记录。

核心行为如下：

1. TUI 在 regular turn 运行时提交 steer，并保留 pending preview。
2. Backend 将已接受输入放入 active turn mailbox。
3. 每次模型采样完成后，regular task 检查 mailbox；存在输入时在同一 turn 继续。
4. 输入被交给模型前，通过统一路径写 conversation history 并发出 UserMessage item
   lifecycle。
5. task 完成时若 mailbox 仍有已接受输入，先写 history 和 TUI lifecycle，再发送
   turn completion。
6. steer 因 active-turn race 或不可 steer turn 被拒绝时，由 TUI 转入 rejected queue。
7. Tab follow-up 只保存在 TUI，当前 turn 完成后再作为普通新 turn 提交。

因此，“没有对应 assistant 回复”不等于“不进入历史”；是否进入历史取决于消息是否已
被 backend 接受并提交。

## 设计原则

### 一个提交入口

Backend 新增一个内部统一操作，本文称为 `commit_user_message()`。普通 turn 输入、
mailbox steer 和 task-finish leftover 都必须通过该操作。

该操作按固定顺序完成：

1. 根据 `client_user_message_id` 做幂等检查。
2. 追加模型 conversation user message。
3. 追加 durable `HistoryItemType.USER_MESSAGE`。
4. 追加当前 turn 的 `TurnItemType.USER_MESSAGE`。
5. 持久化 session/turn 状态。
6. 发出 UserMessage item lifecycle。

历史提交成功前不能发送 completed lifecycle。生命周期投影失败不能回滚已经持久化的
用户消息；客户端可通过 `/resume` 恢复。

### Backend 只拥有 active-turn mailbox

每个 regular active turn 拥有一个有序 mailbox。mailbox 只保存 backend 已接受、但
尚未 `commit_user_message()` 的输入。

mailbox 的性质：

- 与 server `turn_id` 绑定。
- 只存在于当前 runtime 进程。
- 按接受顺序 FIFO 消费。
- 使用 `client_user_message_id` 幂等。
- turn 完成前必须 drain 或执行 task-finish leftover commit。
- 不承担 Tab follow-up 和 rejected steer 的跨 turn 调度。

Review、manual compact 等不可 steering 的 turn 不创建可接收用户 steer 的 mailbox。

### TUI 拥有未接受队列

Node TUI 本地维护三种临时状态：

```text
pending_steers[]
rejected_steers[]
queued_follow_ups[]
```

- `pending_steers`：已发送 `turn.steer`，等待 backend commit lifecycle。
- `rejected_steers`：backend 明确拒绝 same-turn steering，等待下一轮提交。
- `queued_follow_ups`：用户按 Tab 明确要求当前 turn 结束后再执行。

这些数组不是 session state，不写 `session.json`、SQLite history 或 backend queue
snapshot。进程退出、崩溃或重新启动后不恢复。

## User Input 数据模型

所有用户提交携带：

```text
client_user_message_id: stable client idempotency key
text: normalized user text
image_paths: ordered local image paths
source: submit | steer
target_turn_id: server turn id for steer, otherwise null
```

`client_user_message_id` 在普通提交、steer retry、lifecycle 和历史 metadata 中保持
不变。Backend 对相同 ID 和相同内容返回已有结果；相同 ID 但不同内容返回 conflict。

旧 `queue_id` 只用于迁移和已有历史去重，不再作为新用户消息的主要 identity。

## Gateway 协议

### `turn.submit`

普通新 turn 请求必须携带 `client_user_message_id`。请求被接受后，backend worker 在
模型执行前调用 `commit_user_message()`。

TUI 可以在 RPC pending 期间显示 submitting 状态，但 committed transcript 由 backend
lifecycle 确认。普通输入不再由 TUI 直接构造 durable transcript item。

### `turn.steer`

请求字段：

```text
client_user_message_id
expected_turn_id
text
local_images[]
```

Backend 在 active-turn lock 下验证：

- active turn 存在；
- `expected_turn_id` 与实际 server turn ID 一致；
- turn kind 支持 steering；
- 输入大小和附件满足限制；
- ID 未与不同内容冲突。

成功响应只表示输入已进入 active-turn mailbox。TUI 继续显示 pending preview，直到收到
对应 UserMessage completed lifecycle。

结构化错误：

```text
no_active_turn
turn_id_mismatch { actual_turn_id }
active_turn_not_steerable { turn_kind }
input_too_large
message_id_conflict
```

`turn_id_mismatch` 且返回的实际 turn 仍为 regular 时，TUI 使用同一
`client_user_message_id` 重试一次。其他可恢复拒绝进入本地 rejected queue。

### UserMessage lifecycle

Gateway 发出 Codex 风格 direct events，并继续使用现有 `runtime.event` mirror：

```text
item.started {
  turn_id,
  item: {
    id,
    type: "user_message",
    client_user_message_id,
    content,
    source
  }
}

item.completed { ...same identity and content... }
```

TUI reducer 对 mirror 去重。`item.started` 建立 lifecycle 状态；`item.completed` 才将
消息从 pending preview 移入 committed transcript。重复 completed event 必须幂等。

迁移期间可以继续发送 legacy `UserMessage`/`queued_message_committed` 投影，但新 TUI
只使用 item lifecycle 作为事实来源。

## Turn 执行状态机

### Canonical item 顺序

Runtime 必须按照 Codex 的 completed-item 顺序构造 durable history。模型一次采样产生的
assistant、reasoning 和 tool item 在完成时先提交；随后才能 drain active-turn mailbox
并提交 steering UserMessage。不能等到整个 turn 结束后才批量保存前面的 assistant item，
也不能在 `/resume` 或 TUI reducer 中重新猜测顺序。

Same-turn steering 的固定顺序是：

```text
initial UserMessage committed
-> provider response item completed
-> completed assistant/tool item persisted
-> active-turn mailbox drained
-> steering UserMessage committed
-> next provider request
```

例如，用户在 `qqq` 的回复仍在生成时发送 `111`，canonical history 必须是：

```text
user: qqq
assistant: response segment 1
user: 111
assistant: response segment 2
```

`turn_items` 可以继续作为当前 turn 的内存聚合，但每个已完成 item 必须携带稳定 identity
和 durable-commit 状态。Turn finalizer 只补写尚未提交的 item；它不能再次保存已完成 item，
也不能改变其顺序。实时 TUI 使用同一 completed lifecycle 追加 transcript，`/resume` 直接
回放 durable history，因此两条路径得到完全相同的顺序。

### 普通提交

```text
TUI submit
-> turn.submit accepted
-> worker starts
-> commit_user_message
-> item.started / item.completed
-> model sampling
```

如果 hook 在 backend 接受前阻止输入，不提交 UserMessage；TUI 显示结构化拒绝。

### Same-turn steering

```text
TUI pending steer
-> turn.steer accepted
-> active-turn mailbox
-> current provider request finishes
-> completed assistant/tool items persist
-> mailbox drain
-> commit_user_message
-> item.started / item.completed
-> same server turn continues sampling
```

多个 steer 按 backend 接受顺序分别提交为多个 user messages。它们不能因文本相同被
合并。

### Completion race

如果 TUI 认为 turn 正在运行，但 backend 已完成：

1. `turn.steer` 返回 `no_active_turn`；或
2. 返回 `turn_id_mismatch` 并且实际 turn 不可重试。

TUI 将原消息移动到 rejected queue。收到当前 turn terminal event 后，TUI 优先把最早
的 rejected steer 通过 `turn.submit` 启动为普通新 turn。

Backend 不创建 persisted `rejected_steer`，也不运行 queue scheduler。

### Non-steerable turn

Review、manual compact 或其他不可 steer turn 返回
`active_turn_not_steerable`。TUI 保留消息并按 rejected queue 规则在 turn 结束后提交。

### Tab follow-up

运行中按 Tab 只写 TUI `queued_follow_ups`，不调用 backend queue RPC。当前 turn
terminal 后：

1. 先提交 rejected steer；
2. rejected queue 为空后，再提交最早 follow-up；
3. 每次只启动一个新 turn；
4. 新 turn 完成后继续提交下一条。

`Alt+Up`/`Shift+Left` 从 TUI 本地取回最新一条普通 follow-up。rejected steer 和
pending steer 不通过 edit-last 操作修改。

### Interrupt

- Backend 已 commit 的 steer 保留在 history，不重新提交。
- Backend 已接受但尚未 commit 的 mailbox 输入，在 abort completion 前执行 leftover
  commit，避免静默丢失。
- TUI 尚未收到接受结果或仍未匹配 lifecycle 的 pending steer 保留本地 identity。
- turn aborted 后，TUI 将仍未确认的 pending steer 合并/转入 rejected queue，并作为
  下一轮普通输入提交。
- Tab follow-up 保持原顺序。
- 模型可见 `<turn_aborted>` marker 不发 UserMessage lifecycle，也不进入可见 transcript。

## TUI 投影

Pending 区域保持 Codex 的三个视觉类别：

```text
Messages to be submitted after next tool call
Messages to be submitted at end of turn
Queued follow-up inputs
```

区别在于这些内容来自 TUI state，而不是 backend revision snapshot。

匹配规则只使用 `client_user_message_id`。文本比较只能用于旧事件迁移，不能作为新协议
去重依据。收到 completed lifecycle 后：

1. 查找对应 pending steer；
2. 从 preview 移除；
3. 以 backend item ID 插入 transcript；
4. 保持相对于 assistant/tool items 的事件顺序。

任务通知和内部 runtime input 不进入这三类用户队列，也不渲染为用户消息。

## Persistence 与 Resume

Durable history 只包含已 committed 用户消息。`/resume` 不恢复：

- RPC 尚未确认的 pending steer；
- backend 明确拒绝后留在 TUI 的 rejected steer；
- Tab queued follow-up；
- 输入框草稿。

因此实时和 resume 的共同事实来源是 `item.completed(UserMessage)` 对应的 durable
history，而不是 TUI queue snapshot。

session transcript 投影必须继续过滤：

- `event_kind=turn_aborted_marker`；
- internal task notification；
- provider-only recovery/context items。

## 旧队列迁移

升级时可能存在旧 `SessionQueueCoordinator` 持久记录。采用一次性 handoff：

1. Backend bootstrap 暴露 legacy queue migration payload。
2. TUI 将 `pending_steer` 和 `rejected_steer` 导入本地 rejected queue。
3. TUI 将旧 `follow_up` 导入本地 follow-up queue。
4. 已有 history 中包含相同 `queue_id` 的记录不导入。
5. TUI 返回 migration acknowledgement。
6. Backend 收到 ack 后清除该 session 的旧 operational queue state。
7. 新 runtime 不再创建新的 persisted user queue record。

如果 TUI 在 ack 前退出，backend 下次继续提供相同 migration payload。handoff 使用
queue ID 幂等，不能重复导入。

迁移窗口结束后删除：

- 用户输入相关的 backend queue scheduler；
- `turn.follow_up` queue mutation；
- `turn.queue.pop` backend mutation；
- `turn.queue.updated` 用户队列 revision snapshot；
- status/bootstrap 中的用户 queue fields。

内部 task notification 必须迁移到独立 runtime mailbox，不复用用户 queue schema。

## 错误与恢复

- Mailbox 接受成功但 RPC 响应丢失：客户端使用同一 ID 重试；backend 返回 duplicate
  accepted，不能产生第二条消息。
- History commit 失败：消息留在 mailbox，不能发送 completed lifecycle。
- Assistant/tool completed-item commit 失败：不能 drain mailbox，也不能提交后续 steering；
  turn 按持久化错误路径结束，避免 durable history 发生因果倒置。
- Lifecycle 发出失败：history 保持 committed；resume 或后续 replay 补回。
- 进程在 mailbox input commit 前崩溃：该输入不从 persisted queue 恢复；这是严格
  Codex 语义，不允许为此重新引入 backend 用户队列双写。
- TUI 收到 completed 但本地 pending 已丢失：仍按 backend item 插入 transcript。
- Worker 启动失败：普通 submit 不产生 committed UserMessage。
- TUI 提交下一条 follow-up 失败：消息保持本地队首并显示错误。
- Session 切换：清空当前 TUI 临时队列，再加载目标 session committed transcript。
- App 退出：不尝试把临时队列写入 backend；这是严格 Codex 语义的一部分。

## 实施顺序

1. 引入 user-input identity 和统一 `commit_user_message()`，保持旧 queue 路径兼容。
2. 增加 item lifecycle gateway 协议和 Node reducer。
3. 给 regular turn 增加 mailbox drain/continue loop 和 task-finish leftover commit。
4. 将 Enter steering 切到 mailbox，增加 typed race errors 和一次 retry。
5. 将 rejected steer、Tab follow-up、edit-last 所有权移动到 TUI。
6. 实施 legacy queue handoff/ack migration。
7. 删除 backend user queue scheduler、revision snapshots 和兼容事件。
8. 清理旧测试和文档引用，保留数据迁移测试。

每一步必须保持普通 turn、approval、clarification、interrupt 和 `/resume` 可用。不能在
mailbox 与 persisted queue 之间长期双写；兼容阶段只允许读取旧 queue 并 handoff。

## 测试矩阵

### Backend

- 普通输入通过统一提交路径。
- 单条和多条 steer 在同一 server turn FIFO commit。
- 相同 ID retry 幂等，不同内容 conflict。
- provider in-flight 时输入只进入 mailbox。
- provider response item 在 steering UserMessage 之前完成并持久化。
- turn finalizer 不重复保存已经 durable committed 的 item。
- 采样后发现 mailbox 时继续同一 turn。
- task finish leftover 在 `turn.completed` 前进入 history。
- no-active、turn mismatch、non-steerable 和 oversize typed errors。
- interrupt 不丢 accepted mailbox input。
- internal task notification 不使用用户 lifecycle。

### Gateway

- item started/completed 顺序与 payload identity。
- direct event 和 runtime mirror 去重。
- mismatch 返回 actual turn ID。
- accepted response 丢失后的 retry 不重复。
- worker start failure不提交用户消息。
- legacy queue handoff 和 ack 幂等。

### TUI

- Enter steer pending -> completed lifecycle -> transcript。
- mismatch retry 一次。
- no-active/non-steerable 转 rejected queue。
- rejected 优先于 Tab follow-up。
- 多条 follow-up 串行启动。
- Alt+Up 只编辑最新普通 follow-up。
- interrupt 恢复未确认 pending steer。
- duplicate/replayed lifecycle 不重复渲染。
- CJK、图片、长文本和窄终端 preview 宽度安全。
- session switch 和进程 restart 清除临时 queue。
- `/resume` 只显示 committed 用户消息。

### End-to-End

- `111` 运行中发送 `qqq`，`qqq` 在同一 turn 中进入 transcript 并影响后续采样。
- `qqq` 运行中发送 `111`，durable history、实时 transcript 和 `/resume` 都严格保持
  `qqq -> assistant segment 1 -> 111 -> assistant segment 2`。
- completion race 将 `qqq` 转为下一轮普通提交，不经过 backend queue scheduler。
- agent 不产生对应回复时，已 accepted 的 `qqq` 仍存在于 committed history。
- 未 accepted 的 queued follow-up 在进程重启后不恢复。
- 旧 persisted queue 升级后只导入一次。
- 实时 transcript 与 resume replay 的用户消息 ID、顺序和内容一致。

## 验收标准

- 所有新用户消息只通过 `commit_user_message()` 进入 durable history。
- Same-turn steer 不创建第二个 backend turn。
- Completed assistant/tool item 必须先于随后消费的 steering UserMessage 持久化；finalizer
  只提交剩余 item，不能重复或重排历史。
- Backend 不再持久化或调度 rejected steer 和 Tab follow-up。
- TUI 只用 `client_user_message_id` 对 pending 和 committed lifecycle 做匹配。
- 已 accepted 的消息在无 assistant 回复时仍可恢复；未 accepted 的本地队列不恢复。
- 中断、竞态、RPC retry 和 event replay 不丢失或重复 committed 用户消息。
- `<turn_aborted>` 与 task notification 不作为可见 UserMessage。
- 旧 persisted queue handoff 后不重复导入。
- Python、Node、类型检查和 lint 全部通过。
