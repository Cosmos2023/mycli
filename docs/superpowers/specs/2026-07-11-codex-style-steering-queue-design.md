# Codex 风格 Steering Queue 设计

## 目标

把 mycli 的 steering queue 和 follow-up queue 做得更接近 Codex，包括后端行为和 TUI 展示。

改完以后需要达到这些效果：

- TUI 直接显示排队中的消息内容，不再只显示数量。
- steering 和 follow-up 分开显示，用户能看懂它们什么时候会执行。
- queue 只在输入框上方显示一次，不再在 footer 重复显示。
- `Alt+Up` 或 `Shift+Left` 只取回最后一条 follow-up。
- 按 `Esc` 中断当前 turn 时，不清空已经排队的消息。
- 后台任务产生的内部 `<task-notification>` 仍然可以进入模型，但不会显示给用户。

## 当前的问题

mycli 后端现在已经有两个队列：

- `steering`：当前 turn 还在运行时补充给主 agent 的消息。
- `follow_up`：当前 turn 结束后，再启动下一轮处理的消息。

后端也已经把消息文本、图片、来源和 `client_turn_id` 传给 TUI。

问题主要出在展示和按键行为上。

当前 TUI 显示的是：

```text
Pending input: steer 1 · follow-up 2
↳ alt+up / shift+left to edit all queued messages

...

steer 1 follow-up 2 Running
```

这里有四个问题：

1. 只能看到数量，看不到具体排队了什么消息。
2. pending 区域和 footer 重复显示相同数量。
3. `Alt+Up` 会清空并取回全部 queue，而 Codex 只取回最后一条 follow-up。
4. 按 `Esc` 中断时，mycli 会先清空 queue，这会破坏 steering 的原本语义。

## 与 Codex 的对应关系

mycli 不需要重写整个 turn 调度系统，现有两个队列已经能对应 Codex 的核心概念：

| mycli | 对应 Codex | 什么时候处理 |
|---|---|---|
| `steering` | pending steer | 当前 turn 的下一个 tool/result 或模型请求安全边界 |
| `follow_up` | queued user message | 当前 turn 结束后启动下一轮 |

Codex 还有一种 `rejected steer`，用于当前 turn 明确不允许 steering 的情况。

mycli 现在没有“不可 steer 的 turn 类型”这一层状态，所以这次不提前增加第三个队列。以后真正支持 review turn、manual compact 等不可 steer 模式时，再补这个状态。

## 改完后的 TUI

### 有 steering 时

```text
• Messages to be submitted after next tool call
  (press esc to interrupt and send immediately)
  ↳ 再检查一下刚才的命令输出
```

这表示消息属于当前 turn，会在下一个安全边界交给主 agent。

### 有 follow-up 时

```text
• Queued follow-up inputs
  ↳ 完成后再总结一下剩余风险
    alt+up edit last queued message
```

这表示消息不会插入当前 turn，而是在当前 turn 结束后启动下一轮。

### 两种消息同时存在时

```text
• Messages to be submitted after next tool call
  (press esc to interrupt and send immediately)
  ↳ 先检查测试失败原因

• Queued follow-up inputs
  ↳ 测试修好以后再整理提交记录
    alt+up edit last queued message
```

steering 永远显示在 follow-up 上面。

## TUI 展示规则

- 空的 section 不显示。
- 每条消息显示实际内容。
- 每条消息最多显示 3 个视觉行。
- 超过 3 行时，显示缩进后的 `…`。
- 第一行使用 `↳`，自动换行后的内容继续缩进。
- 控制字符会被清理，不能破坏终端布局。
- 中文、emoji 和 ANSI 颜色必须按终端视觉宽度计算。
- 只有存在可编辑的 follow-up 时，才显示 `Alt+Up` 或 `Shift+Left` 提示。
- footer 删除 `steer N follow-up N`，避免重复。

## 后端怎么改

### 保留现有队列

`AgentRuntime` 继续作为 queue 的唯一真实来源。

现有消费顺序不变：

- steering 从队首开始消费，在当前 turn 的安全边界进入模型。
- follow-up 从队首开始消费，在当前 turn 结束后启动下一轮。

### 新增“取回最后一条 follow-up”

后端新增一个操作，只删除并返回最新加入的 follow-up。

它不能影响：

- steering queue；
- 更早加入的 follow-up；
- steering queue 中的内部 task notification。

返回值需要保留：

- 消息文本；
- 本地图片路径和 placeholder；
- `client_turn_id`；
- 剩余 queue 的完整快照。

通过 gateway 新增 `turn.queue.pop` 请求。

如果没有 follow-up，返回 `item: null`，queue 保持不变。

原来的 `turn.queue.clear` 保留兼容，但 TUI 不再用它编辑消息。

### 修改中断行为

当前 mycli 中断前会调用 clear queue，这个行为要删除。

新流程是：

1. 用户按 `Esc`。
2. TUI 直接调用 `turn.interrupt`。
3. steering 和 follow-up 都保留。
4. 当前 turn 完成中断。
5. queue scheduler 先处理 steering，再处理 follow-up。

这样 steering 才能达到 Codex 的效果：中断当前工作，然后尽快把补充消息交给 agent。

## 按键行为

### Enter

当前 turn 正在运行时：

1. 用户按 Enter。
2. TUI 调用 `turn.steer`。
3. 后端把消息加入 steering queue。
4. 消息立即出现在 steering 预览中。
5. 到达下一个安全边界后，后端把消息交给模型。
6. 消费完成后，消息从预览中消失。

### Tab

当前 turn 正在运行时：

1. 用户按 Tab。
2. TUI 调用 `turn.follow_up`。
3. 消息显示在 `Queued follow-up inputs` 下方。
4. 当前 turn 结束后，最早加入的 follow-up 启动下一轮。

### Alt+Up / Shift+Left

1. TUI 调用 `turn.queue.pop`。
2. 后端只取出最新的一条 follow-up。
3. 这条消息恢复到输入框。
4. 用户当前正在编辑的草稿保留在后面。
5. steering 和其他 follow-up 继续留在 queue 中。

### Esc

1. 中断当前 turn。
2. 不清空 queue。
3. steering 保持显示。
4. turn 停止后优先处理 steering。
5. follow-up 继续等待后续 turn。

## 内部 Task Notification

后台 Bash 或 subagent 完成后，会向 steering queue 写入 `<task-notification>`。

这些消息必须：

- 保留在后端 queue 中；
- 正常进入主 agent 的下一次模型请求；
- 不出现在 TUI queue 预览中；
- 不计入用户可见的 queue 数量；
- 不触发空白或幽灵 pending 区域。

## 异常情况

- 没有 follow-up 时调用 `turn.queue.pop`，返回空结果，不报错。
- gateway 请求失败时，不修改本地 queue。
- 后端响应中包含 queue 快照，TUI 用它修正可能过期的本地状态。
- 带图片的 follow-up 被取回后，图片 placeholder 和附件信息不能丢失。
- 窄终端下允许换行和截断，但不能挤乱输入框和 footer。

## 测试范围

### Python 后端

- 只弹出最新 follow-up。
- 剩余 follow-up 仍保持 FIFO 顺序。
- steering 和 task notification 不受影响。
- 图片与 `client_turn_id` 不丢失。
- 空 queue 可以安全调用。
- gateway `turn.queue.pop` 返回弹出的 item 和剩余快照。
- interrupt 不会清空 queue。
- steering 仍然在下一个模型请求前被消费。

### TypeScript TUI

- steering 和 follow-up 文本分别投影到 TUI。
- task notification 不显示。
- steering section 显示在 follow-up section 上面。
- 长文本和多行文本最多显示 3 个视觉行。
- footer 不再重复显示 queue 数量。
- `Alt+Up` 只恢复最新 follow-up。
- 其他 queue 内容保持不变。
- 图片附件恢复正常。
- interrupt 后 queue 预览仍然存在。
- 所有渲染行不超过终端宽度。

## 验收标准

- queue 展示结构与 Codex 接近。
- 用户能直接看到每条排队消息的内容。
- steering 和 follow-up 的执行时机清晰可见。
- queue 只显示在输入框上方，不在 footer 重复。
- `Alt+Up` 或 `Shift+Left` 只编辑最新 follow-up。
- `Esc` 不再清空 queue。
- 中断完成后 steering 优先执行。
- 内部 task notification 不出现在 TUI。
- 现有模型调用、工具执行、Shell 生命周期和 session 持久化不受影响。
