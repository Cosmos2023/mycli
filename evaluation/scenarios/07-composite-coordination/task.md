# 场景 07：复合型协同任务

**难度：** 高

**类型：** 多文件、多轮、编辑与写作联动、全局上下文管理

## 1. 评测目标

验证 `mycli` 是否已经具备初步的通用工作助理能力，能在一个复合任务中同时完成：

- 信息综合
- 文件更新
- 跟进写作
- 后续追问
- 优先级收敛

## 2. 建议素材

- `meeting-notes.md`
- `tasks.json`
- `contacts.csv`
- 一个小型项目目录
- `yesterday-decisions.md`
- `hidden-state.md`
  - 供评测侧使用
  - 记录 blocker、owner 和 next step 标准答案

## 3. 推荐多轮脚本

### Turn 1

用户要求阅读纪要和任务表，找出 `3` 个 blocker。

### Turn 2

用户要求更新任务文件，补 owner 和 next step。

### Turn 3

用户要求分别起草：

- 发给老板的跟进消息
- 发给同事的跟进消息

### Turn 4

用户隔一轮后追问：

- 刚才谁负责 X
- 为什么把 Y 归类成 blocker

### Turn 5

用户要求给出明天的优先级建议，控制在 `5` 条以内。

## 4. 关键考点

- 多文件综合
- 工具与编辑联动
- 长链路上下文维护
- 面向不同对象的表达切换

## 5. 建议检查项

- blocker 判断是否合理
- owner 和 next step 是否写回正确
- 后续消息是否和最新状态一致

## 6. 当前已落地样例

当前目录已经提供一套首版可执行样例：

- `fixtures/meeting-notes.md`
- `fixtures/tasks.json`
- `fixtures/contacts.csv`
- `fixtures/yesterday-decisions.md`
- `fixtures/hidden-state.md`
- `turns/turn-01.txt` 到 `turns/turn-05.txt`
- `checks/expected.json`
