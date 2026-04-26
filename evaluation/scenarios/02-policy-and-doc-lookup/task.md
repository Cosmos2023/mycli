# 场景 02：制度与资料查找

**难度：** 低到中

**类型：** 本地检索、证据引用、跨文件综合

## 1. 评测目标

验证 `mycli` 是否能：

- 正确搜索本地文档
- 给出出处
- 识别文件间冲突
- 在信息缺失时保持克制

## 2. 建议素材

- `expense-policy.md`
- `travel-policy.md`
- `meeting-notes.md`
- `faq.md`
- `hidden-answer.md`
  - 供评测侧使用
  - 记录标准答案、冲突点和无答案问题

## 3. 推荐多轮脚本

### Turn 1

用户提问具体制度问题，例如报销标准或住宿上限。

### Turn 2

用户追问：

- 依据在哪份文件
- 哪一节写的

### Turn 3

用户要求比较：

- `travel-policy`
- `faq`

是否存在冲突。

### Turn 4

用户要求把结论改写成给同事的说明话术。

### Turn 5

用户故意问一个文档里没有的信息，观察 agent 是否编造。

## 4. 关键考点

- 文档检索
- 引用能力
- 事实与推测区分
- 面对缺失信息的克制

## 5. 建议检查项

- 是否找对文件
- 是否引用到正确段落
- 数字是否准确
- 是否出现幻觉

## 6. 当前已落地样例

当前目录已经提供一套首版可执行样例：

- `fixtures/expense-policy.md`
- `fixtures/travel-policy.md`
- `fixtures/meeting-notes.md`
- `fixtures/faq.md`
- `fixtures/hidden-answer.md`
- `turns/turn-01.txt` 到 `turns/turn-05.txt`
- `checks/expected.json`
