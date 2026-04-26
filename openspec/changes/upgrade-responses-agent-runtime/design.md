## Context

`mycli` 当前已经具备 Responses-first 的默认模型链路、基础的 `ResponsesModelAdapter`、block/item-first runtime、CLI activity stream 和工作区日志。但从真实运行日志可以看到，模型已经在 Responses 返回里提供了 `reasoning.summary`、`function_call` 等更贴近 agent 的结构，runtime 却只消费了极小一部分内容。这导致模型虽然“在思考、在规划、在决定工具”，`mycli` 却更像只看到了工具调用和最终文本，没能把 Responses 的 agent-native 语义真正吃透。

这次变更的目标，是在不推倒现有 runtime block/item-first 架构的前提下，把 Responses 语义适配补完整，并在同一套运行时事件模型上叠加 streaming，让前台执行过程更像真正的 agent console。

约束：
- 第一版继续使用标准库，不引入新的 streaming SDK 依赖。
- 保持现有 legacy chat fallback 可用，但新的设计不再以它为锚点。
- 保持 CLI 文本交互形态，不在本轮改成复杂 TUI。
- 优先覆盖 text + reasoning + tool-call 这条主链，不扩展到多模态和 hosted tools 全覆盖。

## Goals / Non-Goals

**Goals:**
- 补齐 non-streaming Responses item 的正式适配，尤其是 `reasoning`、`summary`、`function_call` 和 `message.output_text`
- 在 `ModelTurnResult` / `RuntimeBlock` 中保留必要的 provider metadata
- 让 runtime 把 Responses reasoning 作为 activity event 的一等来源
- 为 Responses client 增加 streaming 能力，并把它接入现有 runtime / CLI 链路
- 让 CLI 能显示更真实的 agent 执行过程和逐步形成的答案
- 增加日志与测试，确保非流式和流式路径都可诊断

**Non-Goals:**
- 不在本轮做图片、音频或其他多模态输出全量支持
- 不接入 OpenAI hosted tools 的完整执行模型
- 不统一抽象所有 provider 的 streaming 协议
- 不在本轮重做 CLI 为完整 TUI 或状态栏系统
- 不设计新的 transcript 存储格式，继续沿用现有 block/item-first 结构

## Decisions

### 1. 先完善 non-streaming 语义，再叠加 streaming

这次变更不会直接以 streaming 为中心重做前台，而是先补齐 non-streaming Responses 语义适配，再让 streaming 复用同一套 runtime 语义。

为什么这样设计：
- non-streaming 响应是最稳定的真值来源，先把它吃透，streaming 才不会漂。
- runtime、日志和测试都能围绕同一套语义模型构建，避免流式和非流式两套逻辑分叉。

考虑过的替代方案：
- 直接以 streaming 为中心重做：否决，因为会把协议适配和前台展示耦死，难以定位问题。

### 2. 继续复用 `RuntimeBlock`，不再引入第三套协议模型

Responses item 不直接暴露给 runtime 上层，而是映射到现有的：
- `RuntimeBlock(type="reasoning")`
- `RuntimeBlock(type="text")`
- `RuntimeBlock(type="tool_call")`

为什么这样设计：
- 当前 runtime 已经围绕 block/item-first 结构工作，继续复用是最小闭环。
- CLI activity stream、tool reinjection、session transcript 都能继续建立在同一层上。

考虑过的替代方案：
- 在 runtime 内直接传播原始 Responses item：否决，因为会让 provider 语义泄漏到整个应用层。

### 3. 把 Responses reasoning 作为 activity stream 的正式信号源

当前 activity 主要来自 runtime 本地节点与工具调用。本轮会明确把 Responses reasoning 作为一等输入，驱动 `thinking` / `planning` 事件。

为什么这样设计：
- 这是 Responses 最贴近 agent 的价值之一。
- 只有吃到 reasoning，前台才能解释“模型为什么继续读文件、为什么下一步选某个工具”。

考虑过的替代方案：
- 继续只在模型请求前发固定 `Thinking`：否决，因为这只能显示“开始想了”，不能显示“在想什么”。

### 4. streaming 只作为“更早到达的语义”，不是另一套输出协议

Responses streaming event 不直接给 CLI，而是先由 client/adapter/runtime 归一化，再生成现有 activity 和 assistant text 更新。

为什么这样设计：
- 保持前台只消费统一语义，而不是 provider 原始事件。
- streaming 和 non-streaming 共享一套消费逻辑，测试和日志更一致。

考虑过的替代方案：
- CLI 直接消费 provider streaming event：否决，因为界面层不应该理解 Responses wire protocol。

### 5. 对未知 item 采取“warning + ignore”策略

对于第一版未正式支持的 Responses item，系统不应整体失败，而应：
- 记录 warning
- 在安全前提下忽略

为什么这样设计：
- Responses 协议在演进，硬失败会让 agent 过于脆弱。
- 结合工作区日志，warning 已足够帮助我们后续补齐支持。

考虑过的替代方案：
- 遇到未知 item 即抛错：否决，因为这会让 provider 轻微变动直接打断整轮 turn。

## Risks / Trade-offs

- [流式实现增加复杂度，导致 runtime 分叉] → 把 streaming 设计成 non-streaming 语义层的增量来源，而不是另一套 runtime。
- [Responses reasoning 过多导致前台太吵] → 将 reasoning 先归一化为 `thinking/planning` 活动，不直接裸露全部 provider 原文。
- [未知 item 被忽略后丢信息] → 同时记录 warning 和原始日志，方便后续补支持。
- [流式答案与最终 assistant_message 重复] → 保持 streamed chunk 与最终答案分层，CLI 明确渲染顺序。
- [legacy chat 路径与 Responses 路径能力继续分叉] → 接受该差异，因为本次目标就是让 Responses 成为 agent 主协议。

## Migration Plan

1. 扩展 Responses adapter 的 non-streaming 语义适配，并补齐相关测试。
2. 在 runtime 中消费 Responses reasoning block，让 activity stream 基于真实模型语义发射。
3. 为 Responses client 增加 streaming 能力，并把流式事件归一化到现有 runtime/CLI 链路。
4. 扩展 CLI 渲染 streamed chunks 和 richer activity。
5. 增加 warning/logging 与回归测试，确认新增路径不破坏当前交互。

回滚策略：
- 直接回滚该 change 即可；第一版不涉及 session schema 迁移，也不改变现有日志格式契约。

## Open Questions

- 对 streamed answer 的前台渲染，最终是否保留单独 `[stream]` 标签，还是直接拼成实时答案输出。
- Responses reasoning 是否需要进一步区分 `thinking`、`planning`、`decision` 三类，而不是当前的二分法。
- 将来如果接入更多 provider，是否复用同一 streaming 归一化层，还是为不同 provider 建独立 adapter。
