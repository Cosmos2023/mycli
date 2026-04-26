# 场景 05：中断后的任务恢复

**难度：** 中到高

**类型：** 多轮记忆、任务切换、上下文恢复

## 1. 评测目标

验证 `mycli` 是否能在被打断之后：

- 保留主任务状态
- 记住优先级和时间约束
- 恢复时不丢上下文
- 能解释自己的排序逻辑

## 2. 建议素材

- `todo-list.md`
- `project-context.md`
- 一条中途插入的无关任务
- `hidden-priority-notes.md`
  - 供评测侧使用
  - 记录正确优先级与时间限制

## 3. 推荐多轮脚本

### Turn 1

用户要求基于待办整理今天的行动计划。

### Turn 2

用户补充：

- 下午两点前不能安排外部会议
- 优先推进 A，不要先碰 B

### Turn 3

插入无关任务，例如润色一条请假消息。

### Turn 4

切回主任务，追加：

- 下午要留 1 小时处理突发问题

### Turn 5

用户追问为什么 A 排在 B 前面。

## 4. 关键考点

- 会话记忆
- 主任务恢复
- 多约束并存
- 排序解释能力

## 5. 建议检查项

- 是否仍记得 A/B 优先关系
- 是否违反时间限制
- 是否被插入任务污染主任务

## 6. 当前已落地样例

当前目录已经提供一套首版可执行样例：

- `fixtures/todo-list.md`
- `fixtures/project-context.md`
- `fixtures/interrupting-task.txt`
- `fixtures/hidden-priority-notes.md`
- `turns/turn-01.txt` 到 `turns/turn-05.txt`
- `checks/expected.json`
