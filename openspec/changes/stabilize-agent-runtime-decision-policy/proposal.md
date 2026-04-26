## Why

`mycli` 已经有了 turn context、capability injection 和 tool exposure / router 骨架，但真实 smoke 仍然暴露出更深一层的问题：agent 在证据型任务中仍会被错误搜索结果带偏、反复读取同一文件、对日志和 `model-raw` 噪音赋予过高权重，并且在 evidence 已足够时不会稳定收口回答。阶段三后半段如果继续接 dynamic tools、MCP 或更多 capability，而不先把 runtime 的任务推进与收口决策层稳住，只会把这些质量问题放大。

## What Changes

- 将这条 change 明确定位为 `general-agent runtime stabilization` 的第一阶段：优先稳定 agent 的任务推进、证据判定、换路与收口行为，而不是继续追加零散 heuristic。
- 引入正式的 `agent runtime decision policy` 作为 runtime stabilization 的决策子层，把“如何搜索、何时换路、何时停止、何时回答”从零散 heuristic 提升为 runtime 主链中的独立策略层。
- 用 `decision profile / policy signals` 而不是硬编码任务分类来表达当前 turn 的推进风格，至少覆盖：
  - source-first overview
  - source-first verification
  - failure investigation
- 明确这套策略服务的是通用 agent runtime，而不是单一的“仓库探索优化”：
  - 解决信息获取阶段的漂移
  - 解决 evidence 已足够后的迟迟不收口
  - 解决重复工具调用前缺少 reroute / answer 决策
  - 先以代码库分析、实现验收、debugging 作为高信号样本任务验证，而不是把代码库分析固化成产品主目标
- 为搜索与读取路径增加更明确的优先级规则：
  - 优先源码 / 配置主路径
  - 降低 `log/`、`model-raw/`、无关 docs 的默认权重
  - `read_file` 截断后优先切换 `read_file_range`
- 为 evidence sufficiency 建立正式判定，而不是只依赖 prompt 中模糊的“if enough evidence”提醒。
- 为 repeated exploration 增加更细粒度的换路与收口策略，避免 agent 在明知已有线索后仍重复读同一文件直到触发 loop stop。
- 让 turn context / runtime reminders / activity / trace 能更明确表达当前探索策略与收口状态。

## Capabilities

### New Capabilities
- `agent-runtime-decision-policy`: 作为通用 agent runtime stabilization 的第一阶段，定义基于 decision profile 与 policy signals 的探索策略、源码主路径优先、噪音降权、evidence sufficiency 判定、截断后换路以及 repeated exploration 收口规则。

### Modified Capabilities
- `repo-analysis-discipline`: 将代码库分析类纪律从独立启发式降级为通用 runtime stabilization 中的一个样本任务分支，并补强对实现验收与证据型问题的约束。

## Impact

- 受影响代码：
  - `src/mycli/services/runtime_policy.py`
  - `src/mycli/prompts/react.py`
  - `src/mycli/services/context/turn_context_assembler.py`
  - `src/mycli/services/context/context_manager.py`
  - `src/mycli/application/runtime/agent_runtime.py`
  - CLI activity / trace 相关渲染逻辑
- 受影响行为：
  - codebase-analysis-like requests、verification-like requests、debugging-like requests 的推进节奏
  - agent 的 evidence gathering、reroute 与 answer timing
  - search_text / read_file / read_file_range 的使用顺序
- 受影响测试：
  - runtime policy
  - agent runtime smoke
  - prompt/context reminders
  - CLI activity / trace regression
