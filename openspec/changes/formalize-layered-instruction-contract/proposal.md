## Why

`mycli` 目前已经有 `system prompt`、`react prompt`、turn context、capability injection、tool exposure 和 runtime policy，但模型输入主链仍然带着明显的早期形态：

- 稳定规则、运行时约束、工作区说明、capability 指令仍混在少数 prompt builder 和 runtime 特判里
- `active_skill` 仍会以特殊 system message 直接注入，提示词层级边界不清晰
- turn context 已经装配出来，但模型侧仍缺少一份正式的“分层指令契约”去表达哪些内容属于 base、哪些属于 runtime/developer、哪些属于 contextual user
- 这会继续诱导我们用 prompt patch 或任务关键词分支去补洞，而不是把 agent 做成真正通用的多面手

在 `/tmp/openai-codex` 里，Codex 更接近一种分层装配方式：稳定的 base instructions、turn-scoped developer instructions、contextual user fragments、按需 skill/context injection。值得 `mycli` 借鉴的不是文案本身，而是这套结构化分层方法。

## What Changes

- 为 `mycli` 引入正式的 `layered instruction contract`，把模型输入拆成清晰层级，而不是继续依赖零散 prompt 拼接与 runtime 特判。
- 定义至少四类模型可见输入层：
  - `base instructions`：稳定、低频变化的代理通用契约
  - `developer instructions`：turn-scoped 的 runtime policy、tool exposure、capability policy、approval/runtime reminders
  - `contextual user fragments`：workspace/project instructions、environment context、capability bodies、dynamic tool descriptors 等上下文化片段
  - `conversation messages`：真实对话与工具交互历史
- 让 `AgentRuntime` 与 provider/model adapter 不再直接硬编码“system + active skill + assistant react prompt”三段式主链，而是消费统一的 instruction contract。
- 让 capability / workspace / environment 等注入内容进入显式层级和结构化 turn/trace 语义，而不是继续作为 ad hoc prompt patch 存在。
- 为 prompt scaffolding 建立 memory/summary 边界，避免把项目说明、skill 片段、运行时脚手架误当作长期记忆内容。
- 保持目标是通用 agent runtime 升级，而不是为“仓库总结”“代码修改”之类单一任务做特化 prompt。

## Capabilities

### New Capabilities
- `layered-instruction-contract`: 定义 `mycli` 的基础指令、运行时开发者指令、上下文化用户片段与真实对话消息之间的装配边界、顺序、渲染规则和可观测语义。

### Modified Capabilities
- `turn-context-assembly`: 从“装配 section”进一步升级为“为模型输入提供正式的分层指令来源”。
- `capability-injection`: 从“把 capability 渲染进 context”进一步升级为“把 capability 作为按需 contextual fragment 注入模型主链”。
- `agent-runtime-decision-policy`: 其策略状态和提醒进入 developer instructions，而不是继续只散落在 react prompt 文本中。

## Impact

- 受影响代码：
  - `src/mycli/application/runtime/agent_runtime.py`
  - `src/mycli/prompts/system.py`
  - `src/mycli/prompts/react.py`
  - `src/mycli/services/context/turn_context_assembler.py`
  - 新的 instruction contract / prompt assembly 相关模块
  - conversation / memory / trace 的相关过滤与渲染逻辑
- 受影响行为：
  - 模型输入的层级与顺序
  - capability、workspace instructions、environment context 的注入方式
  - runtime policy、tool exposure、developer guidance 的表达方式
  - memory / summary 是否吸收脚手架型片段
- 受影响测试：
  - prompt assembly / runtime protocol
  - agent runtime turn construction
  - capability / context injection regression
  - memory exclusion / trace visibility
