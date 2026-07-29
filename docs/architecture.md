# mycli 架构整理

本文档记录当前 `fix/deepseek-cache-hit-rate` worktree 的代码组织边界，作为后续 runtime、LLM provider、session/memory 继续拆分的基准。

## 顶层分层

- `src/mycli/cli/`：命令行入口、交互式渲染、参数解析。`main.py` 只保留入口调度；`bootstrap.py` 负责 runtime/model/tool 组装；`rendering.py` 负责 CLI 输出渲染；`repl.py` 负责交互循环和 slash command。
- `src/mycli/application/`：应用层编排。`runtime/` 是当前主 agent runtime，负责 turn 生命周期、模型请求、工具执行和状态落盘的协调。
- `src/mycli/domain/`：领域模型和纯数据结构，例如 conversation、runtime blocks、tool calls、provider 配置、request shape。该层不依赖基础设施。
- `src/mycli/config/`：配置解析和 provider/protocol 配置校验。
- `src/mycli/memory/`：会话记忆和 runtime context 收集。
- `src/mycli/state/`：session snapshot、history、pending approval、Responses continuation state 持久化边界。
- `src/mycli/llms/`：LLM 集成层，隔离 provider client 和 model adapter。
- `src/mycli/tools/`：agent 可调用工具、工具路由和工具暴露计划。
- `src/mycli/utils/`：与业务无关的横切辅助能力，目前包含 workspace 结构化日志。
- `src/mycli/services/`：横切服务层。真实实现按职责放入子包，根目录只保留少量兼容导出，例如旧 `memory_service.py`、`skill_registry.py`、`trace_service.py` 路径。
- `src/mycli/infrastructure/`：底层外部系统适配和旧 provider/model import 兼容层，例如 SQLite、SSL、provider profile、shell/filesystem。
- `src/mycli/prompts/`：系统提示词、ReAct scaffold 和 prompt 构建逻辑。
- `src/mycli/schemas/`：外部 API wire/protocol schema。

## Runtime 模块边界

- `application/runtime/agent_runtime.py`：主编排器，保留 turn 生命周期、服务协作、错误处理和持久化。
- `application/runtime/turn_executor.py`：单次 turn 执行循环，处理模型调用和工具调用之间的推进。
- `application/runtime/turn_error_finalizer.py`：模型错误和 runtime 异常的失败响应收束。
- `application/runtime/runtime_policy_coordinator.py`：runtime policy 决策和 policy/planning activity 记录。
- `application/runtime/response_finalizer.py`：turn record、结构化 runtime state、turn-scoped contributed tool 过期和最终 response 组装。
- `application/runtime/planning_effects.py`：`update_plan` 工具副作用和 active plan item 自动完成。
- `application/runtime/approval_decisions.py`：pending approval 到 pending decision 的转换和 CLI 选择文案。
- `application/runtime/capability_turn_recorder.py`：capability activation turn item 记录。
- `application/runtime/request/`：provider-visible request shape、payload formatting、cache shape diagnostics；`message_projection.py` 负责 conversation message 到 provider message/runtime block 的纯转换。
- `application/runtime/context/`：runtime turn context、skill 选择和 capability activation 到 active skill 的转换。
- `application/runtime/model/`：模型 turn 请求、model adapter 状态、Responses continuation state 读写和 assistant block 消费。
- `application/runtime/tools/`：工具暴露、路由、执行和工具活动事件。
- `application/runtime/ledger/`：runtime event ledger。
- `application/runtime/runtime_error_logger.py`：runtime 异常 payload 落盘和用户可见错误详情。

后续拆分原则：

- `agent_runtime.py` 只保留主生命周期协调和旧私有方法兼容 wrapper，工具活动、continuation state、turn persistence 已逐步外移。
- request shape 和 provider payload 只允许在 `application/runtime/request/` 或 `llms/` 中演进，避免重新散落到 runtime 主类。
- session/history/continuation state 的读写应收敛到 `state/` 和 runtime ledger 边界。

## LLM 模块边界

- `llms/clients/openai_chat.py`：OpenAI-compatible Chat Completions client，包括 DeepSeek 这类 chat-compatible provider；SDK wrapper、payload 解码和错误类型已拆到相邻模块。
- `llms/clients/openai_responses.py`：OpenAI-compatible Responses client，包括 Qwen Responses 兼容接口；logging、error factory、stream helper、event mapper 已拆成独立模块。
- `llms/clients/anthropic_messages.py`：Anthropic Messages client。
- `llms/adapters/base.py`：model adapter 协议和 runtime block/message 类型桥接。
- `llms/adapters/responses_adapter.py`：Responses API 事件与 runtime turn result 的适配；input serialization、output parsing、stream event state 分别在独立模块中维护。
- `llms/adapters/native_tool_adapter.py`、`responses_adapter.py`、`anthropic_messages_adapter.py`：各协议 adapter。

Provider client 只负责协议请求、响应解析、错误归一化和原始日志。Agent runtime 不应把 provider-specific 细节散落在多个应用层模块中。

## 模板映射

参考常见 agent 项目的 `config/`、`memory/`、`llms/`、`tools/`、`utils/logger` 分层，当前仓库的对应关系是：

- `config/settings.py`：配置层。
- `memory/service.py`：记忆层。
- `state/session_service.py`：状态和会话管理层，message/runtime block 序列化在 `state/session_serialization.py`。
- `llms/clients/` + `llms/adapters/`：LLM 集成层。
- `tools/` + `tools/routing/` + `application/runtime/tools/`：工具层。runtime contributed tool registry/provider 放在 `application/runtime/tools/`。
- `utils/workspace_logger.py`：日志辅助。
- `services/context/`：turn context 和 instruction contract 组装。
- `services/context/window_service.py`：context window 截断与摘要窗口计算。
- `services/planning/`：计划状态更新。
- `services/approval/`：工具调用审批和 safety policy。
- `services/capabilities/`：capability/skill activation 解析。
- `services/skills/`：skill registry 和 skill 文件加载。
- `services/tracing/`：runtime trace JSONL 读写。
- `services/runtime_policy/`：runtime policy 主入口；证据判断、重复调用信号、profile 判断、阶段文案分别拆到 `evidence.py`、`signals.py`、`profiles.py`、`stages.py`。

## Domain 模块边界

- `domain/runtime/`：turn state、runtime block、instruction contract、tracing、request shape 等 runtime 领域模型。
- `domain/tooling/`：工具调用、工具结果、动态工具、工具暴露和工具集合领域模型。
旧的 domain、service 和 infrastructure 重导出路径不再保留。仓库代码和测试统一从上述 canonical 模块导入，避免形成多套等价入口。

## 当前遗留风险

- `application/runtime/agent_runtime.py` 仍然偏大，下一步应继续拆出 provider continuation、tool activity、turn persistence。
- `llms/clients/openai_responses.py` 仍然偏大，后续可继续拆 continuation retry/state bookkeeping。
- `llms/adapters/responses_adapter.py` 已拆到主流程级别，后续主要关注测试覆盖。
- `application/turn_service.py` 和 `agents/react_loop.py` 仍是兼容/旧式路径，需要在确认 CLI 和测试迁移完成后再决定删除或降级为兼容层。
