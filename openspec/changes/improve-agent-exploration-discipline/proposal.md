## Why

当前 `mycli` 在“分析这个仓库/说明入口文件和主要模块”这类请求上，容易在只读取 `README.md` 和根目录后就提前总结。`Responses` 协议与活动流已经初步产品化，但 agent 在“何时继续探索、何时可以回答、回答时如何区分事实与推断”上仍缺少正式约束，这已经成为下一阶段体验和可信度的主要瓶颈。

## What Changes

- 为仓库分析类请求引入正式的探索纪律，而不是沿用通用 overview heuristic。
- 提高“证据已足够”的门槛，禁止仅凭 `README.md` 加一次目录列表就进入最终总结。
- 要求分析型回答在证据不足时显式区分“已确认事实”和“推断判断”，并指出缺失的验证路径。
- 为仓库分析类探索建立更明确的工具路由偏好，优先使用 `list_directory`、`search_text`、`read_file_range` 以及真实源码/配置文件证据，而不是大段依赖说明文档。
- 为探索过程补充结构化活动语义，让 CLI 能更清楚地展示“正在看目录”“正在读源码”“已从证据收口回答”等关键阶段。

## Capabilities

### New Capabilities
- `repo-analysis-discipline`: 为仓库分析类请求定义多源证据门槛、探索收口策略、事实/推断边界以及结构化探索活动。

### Modified Capabilities

## Impact

- 影响运行时策略层，尤其是 `src/mycli/services/runtime_policy.py`。
- 影响 agent prompt 契约，尤其是 `src/mycli/prompts/react.py`。
- 影响上下文与工具证据塑形，尤其是 `src/mycli/services/context/context_manager.py`。
- 影响 CLI 活动流展示，尤其是 `src/mycli/cli/main.py` 与 turn/activity 相关模型。
- 需要补充回归测试与 smoke case，覆盖“只读 README 就总结”的失败路径。
