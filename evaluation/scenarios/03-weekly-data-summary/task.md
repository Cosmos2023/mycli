# 场景 03：周报数据整理与异常解释

**难度：** 中

**类型：** 结构化数据处理、文本生成、追问解释

## 1. 评测目标

验证 `mycli` 是否能：

- 正确处理结构化数据
- 找出异常点并解释理由
- 把数据结论稳定迁移到后续周报文本
- 在追加限制后更新说法

## 2. 建议素材

- `weekly_sales.csv`
- `support_tickets.csv`
- `team_hours.csv`
- `hidden-metrics.json`
  - 供评测侧使用
  - 记录标准汇总值与异常点

## 3. 推荐多轮脚本

### Turn 1

用户要求总结本周核心数据，并指出三个异常点。

### Turn 2

用户追问其中一个异常为什么成立。

### Turn 3

用户要求基于这些数据写经理周报，语气稳健。

### Turn 4

用户追加限制：

- 不要提某位员工名字

### Turn 5

用户追问：

- 下周最需要优先处理哪个异常

## 4. 关键考点

- 数据计算正确性
- 工具调用
- 解释能力
- 文本与数据的一致性

## 5. 建议检查项

- 汇总数字是否正确
- 异常是否站得住脚
- 周报是否与前文数据一致
- 是否遵守新增限制

## 6. 当前已落地样例

当前目录已经提供一套首版可执行样例：

- `fixtures/weekly_sales.csv`
- `fixtures/support_tickets.csv`
- `fixtures/team_hours.csv`
- `fixtures/hidden-metrics.json`
- `turns/turn-01.txt` 到 `turns/turn-05.txt`
- `checks/expected.json`
