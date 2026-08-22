# AGENTS.md

## 项目使命
- 构建一个基于 Node.js 与 TypeScript 的 coding agent，它不仅能够编写和修改代码，还能够分析文件、协助完成日常任务，并作为一个可靠的个人助手存在。
- 即使项目当前规模较小，也要把这个仓库当作企业级代码库来建设。
- 以可维护性、清晰边界、可测试性和安全执行为核心优化方向。

## 产品范围
- 核心能力包括：
  - 代码生成与代码修改
  - 仓库与文件分析
  - 本地开发流程中的任务执行协助
  - 面向重复性日常任务的个人助手式自动化能力
- Agent 应该能够理解代码文件与非代码文件，总结关键发现，提出下一步建议，并在合适时执行边界明确的操作。

## 工程基线
- Node.js 版本：`>=22.19.0`，同时支持 Node 24。
- 包管理与工作区：npm workspace，使用根目录 `package-lock.json`。
- TypeScript 启用严格类型检查；生产入口必须编译到 `dist/`，开发入口通过 `mycli-source` 条件解析 `src/`。
- 所有公共函数、类方法以及模块级接口，优先补齐显式类型标注。
- 优先使用 Node.js 标准库。只有在第三方依赖能带来明确长期价值时才引入。
- 保持模块小而专一，确保结构易读、易查找。
- 除非继承明显更合适，否则优先组合而不是继承。

## 推荐仓库结构
- 除非有充分理由，否则优先采用如下结构：

```text
backend/
  apps/mycli/
  packages/
    config/
    contracts/
    core/
    integrations/
    providers/
    runtime/
    storage/
    tools/
tui/mycli-shell/
native/
npm/ripgrep/
tests/
  fixtures/
scripts/
docs/
```

- 目录职责说明：
  - `backend/apps/mycli/`：命令行入口、管理命令、运行时组装和 TUI gateway
  - `backend/packages/core/`：不依赖基础设施的核心领域类型与规则
  - `backend/packages/runtime/`：turn、worker、compaction、恢复与 Agent 调度
  - `backend/packages/storage/`：SQLite、append-only transcript 与可读投影
  - `backend/packages/providers/`：模型提供方协议与传输适配
  - `backend/packages/tools/`：文件、shell、审批、sandbox 与 ripgrep 适配
  - `backend/packages/integrations/`：MCP、skills、hooks、plugins 与 subagents
  - `backend/packages/contracts/`：canonical JSON Schema、生成的 TypeScript 类型与验证
  - `tui/mycli-shell/`：终端 UI、gateway client 与 reducer
  - `tests/fixtures/`：由 Node 测试消费并校验哈希的语言无关回归数据
  - `native/` 与 `npm/`：平台 helper 源码和发布专用原生 npm 包

## 编码规范
- 遵循仓库 ESLint、TypeScript strict mode 与现有 Node.js 模块风格。
- 命名规则：
  - 多词模块与包：`kebab-case`
  - 函数与变量：`camelCase`
  - 类：`PascalCase`
  - 常量：`UPPER_SNAKE_CASE`
- 函数应保持单一职责，具备良好可读性。
- 避免过度炫技式抽象。
- 文件与路径处理优先使用 `node:path`、`node:url` 和 `node:fs` 的结构化 API。
- 应用行为优先使用现有结构化诊断与事件边界；只在 CLI/stdout 协议边界直接输出。
- 抛出明确、具体的异常，并尽量在最接近可恢复边界的位置处理错误。
- 当数据结构相对稳定时，优先使用只读 interface/type 与运行时验证，而不是松散的 `Record<string, unknown>`。

## 架构规则
- 不要把业务逻辑放进 CLI 处理器或基础设施适配层中。
- 将纯决策逻辑与副作用明确分离。
- 模型提供方、shell 调用、文件 IO 和外部集成都应放在清晰的接口之后。
- Agent 工作流应设计为无需依赖真实外部服务也能测试。
- 通过保持清晰的依赖方向避免循环引用：
  - `core` 与 `contracts` 不应依赖 app 组装层
  - `runtime` 可以依赖 `core` 和上层定义的接口
  - providers、storage、tools 与 integrations 通过明确接口接入 runtime
  - TUI 依赖 contracts 与 gateway API，不依赖 backend 实现模块

## Codex 工作约定
- 在开始编码前：
  - 先查看相关模块和现有实现模式
  - 采用能够解决问题的最小闭环修改
  - 保持目录结构和命名风格一致
- 在新增功能时：
  - 把代码放到正确的分层中
  - 添加或更新测试
  - 如果行为或命令发生变化，同步更新文档
- 在分析文件时：
  - 总结文件用途、关键发现、风险点和建议的后续动作
  - 明确区分事实与推测
  - 缺少上下文时要直接指出
- 在处理日常助手类任务时：
  - 优先选择安全、可回退的操作
  - 对破坏性或高影响步骤，先说明再执行

## 质量门槛
- 对于每一个非简单改动，应尽量包含：
  - 核心逻辑的单元测试
  - 边界或工具适配层相关的集成测试
  - 类型安全的接口定义
- 如果相关工具链尚未搭建，应以干净、最小化的方式建立。
- 使用仓库现有工具链：
  - 依赖与环境管理：`npm ci`
  - lint：`npm run lint`
  - 测试：Node `node:test` 与 `npm test`
  - 静态类型检查：`npm run typecheck`
  - contract drift：`npm run contracts:check`

## 安全与审批
- 不要在日志或输出中暴露密钥、API Key、Token 或私有本地数据。
- 对破坏性文件操作、不可逆迁移或大范围依赖变更，应先征求确认。
- 对 shell 执行和外部副作用保持保守态度。
- 在可能的情况下，优先提供 dry-run 或预览能力。

## 变更管理
- 保持 diff 聚焦。
- 除非任务明确要求，否则不要重构无关区域。
- 不要在没有明确收益的情况下重命名文件或大规模移动代码结构。
- 除非任务明确允许，否则尽量保持向后兼容。

## 沟通风格
- 保持简洁、准确、以落地实现为导向。
- 在执行分析任务时，优先说明：
  - 文件或模块是做什么的
  - 最重要的信息是什么
  - 风险和不明确之处在哪里
  - 下一步建议做什么
- 在执行实现任务时，如果设计受到假设影响，需要在完成后明确说明这些假设。

## 早期项目规则
- 这个仓库在早期阶段可能几乎没有脚手架。
- 当项目还比较空时，优先建立干净的基础设施，而不是快速堆积临时方案。
- 新增文件和目录时应有明确意图，并放在能够支撑后续扩展的位置。
