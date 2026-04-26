## Why

`mycli` 当前已经具备 Responses-first、工具系统、activity stream、workspace logging 和 session 基础能力，但真实 smoke test 表明它仍然更像“会调工具的模型壳子”，而不是“具备自约束执行纪律的 agent runtime”。问题已经不再是补几个协议兼容点，而是需要把内部运行时协议、状态生命周期和执行纪律一起产品化，否则继续叠加工具、日志和 UI 只会增加复杂度，不会显著提升可靠性。

## What Changes

- 建立 `mycli` 的内部 agent runtime protocol，正式定义 thread、turn、turn item、approval lifecycle、stop reason 等稳定对象，隔离 provider wire protocol 与 CLI/UI。
- 引入 runtime discipline 层，负责 grounded planning、evidence sufficiency、exploration budget、loop detection 和 stop policy，而不是把“什么时候停”完全交给模型自觉。
- 将文件和目录类工具升级为可恢复的结构化执行契约，让“不存在的文件”“权限不足”等错误返回给模型继续推理，而不是直接打断整轮 turn。
- 明确 provider compatibility、runtime orchestration、session/state、surface 的分层边界，为后续 TUI、IDE、Web surface 复用统一运行时打基础。
- 为 trace、session persistence 和 CLI activity 提供统一的 runtime 事件来源，提高可解释性、可观测性和调试效率。

## Capabilities

### New Capabilities
- `agent-runtime-protocol`: 定义 `mycli` 内部稳定的 thread / turn / item / approval / stop-reason 协议以及统一事件语义。
- `agent-runtime-discipline`: 定义 agent 如何基于证据规划、检测重复探索、控制探索预算并在合适时机停止回答。
- `recoverable-tool-runtime`: 定义工具执行失败如何以结构化、可恢复结果返回给 runtime 和模型，而不是直接抛出运行时异常。

### Modified Capabilities

None.

## Impact

- 受影响代码：`src/mycli/application/runtime/agent_runtime.py`、`src/mycli/infrastructure/models/responses_adapter.py`、`src/mycli/infrastructure/openai_responses_client.py`、`src/mycli/services/context/*`、`src/mycli/prompts/*`、`src/mycli/tools/*`、`src/mycli/cli/main.py`
- 受影响状态与日志：session transcript、trace、workspace log、model raw log
- 受影响测试：runtime、adapter、tool contract、CLI activity、session persistence 相关单元与集成测试
- 外部依赖：继续使用现有 OpenAI Responses 链路，不新增第三方依赖
- 用户可见影响：`mycli` 将更像成熟 agent，能够更稳定地展示执行过程、减少无意义重复探索，并在工具失败时给出可恢复反馈
