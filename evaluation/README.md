# mycli Evaluation

这个目录用于承载 `mycli` 的通用 agent 评测资产。

当前结构分为三层：

- `suite design`
  - [2026-04-16-mycli-daily-general-agent-eval-suite-design.md](/Users/cosmos/Desktop/mycli/evaluation/2026-04-16-mycli-daily-general-agent-eval-suite-design.md)
  - 用于说明这套评测为什么这样设计、借鉴了哪些公开 benchmark、总体覆盖哪些能力
- `rubric`
  - [rubric/scoring-rubric.md](/Users/cosmos/Desktop/mycli/evaluation/rubric/scoring-rubric.md)
  - 用于统一评分维度、分值权重和执行建议
- `scenarios`
  - `7` 个场景，每个场景一个目录
  - 当前已落：
    - `task.md`
    - `fixtures/README.md`
    - `turns/script.md`
    - `checks/assertions.md`
  - 后续可以继续补：
    - `artifacts/`

## 目录约定

建议后续每个场景目录都按下面结构演进：

```text
evaluation/
  scenarios/
    01-boss-message-reply/
      task.md
      fixtures/
        README.md
      turns/
        script.md
      checks/
        assertions.md
    02-policy-and-doc-lookup/
      task.md
      fixtures/
        README.md
      turns/
        script.md
      checks/
        assertions.md
```

## 场景清单

1. [01-boss-message-reply/task.md](/Users/cosmos/Desktop/mycli/evaluation/scenarios/01-boss-message-reply/task.md)
2. [02-policy-and-doc-lookup/task.md](/Users/cosmos/Desktop/mycli/evaluation/scenarios/02-policy-and-doc-lookup/task.md)
3. [03-weekly-data-summary/task.md](/Users/cosmos/Desktop/mycli/evaluation/scenarios/03-weekly-data-summary/task.md)
4. [04-small-scope-modification/task.md](/Users/cosmos/Desktop/mycli/evaluation/scenarios/04-small-scope-modification/task.md)
5. [05-interruption-and-resume/task.md](/Users/cosmos/Desktop/mycli/evaluation/scenarios/05-interruption-and-resume/task.md)
6. [06-online-research-and-recommendation/task.md](/Users/cosmos/Desktop/mycli/evaluation/scenarios/06-online-research-and-recommendation/task.md)
7. [07-composite-coordination/task.md](/Users/cosmos/Desktop/mycli/evaluation/scenarios/07-composite-coordination/task.md)

## 当前进度

- 场景 `01` 到场景 `07` 已全部补到“首版真实样题”级别：
  - 已有实际 `fixtures`
  - 已有逐轮 `turn-01.txt` 到 `turn-05.txt`
  - 已有机器可读的 `checks/expected.json`
- 当前可以继续做的不是“补齐空白”，而是：
  - 细化自动检查器
  - 为修改类任务加入真实执行脚本
  - 为联网调研类任务补更明确的评测运行说明

## 当前可用的执行入口

当前仓库已经接入了一个轻量 CLI 入口：

```bash
PYTHONPATH=src python3 -m mycli.cli.main --eval-list
PYTHONPATH=src python3 -m mycli.cli.main --eval-scenario 01
PYTHONPATH=src python3 -m mycli.cli.main --eval-scenario 04-small-scope-modification
```

说明：

- `--eval-list`
  - 列出当前所有场景
  - 不依赖模型配置
- `--eval-scenario`
  - 会按 `turn-01..05` 顺序执行单个场景
  - 默认从 `evaluation/scenarios/` 加载场景
  - 会基于 `checks/expected.json` 输出首版确定性检查结果
  - 会默认把本次运行结果写到 `evaluation/runs/`
  - 会为每次评测自动生成隔离的 session id，避免污染普通对话会话
- 真正运行 `--eval-scenario` 时，仍需要 `mycli` 正常可用的模型配置和 API Key
  - 若缺少配置，CLI 会输出友好错误，而不是直接抛出栈追踪

## 当前拆分原则

- 总设计文档保留在目录根部，作为总纲
- 评分单独拆出，便于后续复用
- 每个场景都拆成任务定义、素材说明、固定多轮脚本、断言清单
- 先把“题目形状”和执行接口固定，再逐步补真实素材和自动检查器
