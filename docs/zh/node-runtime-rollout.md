<a id="node-only-runtime-rollout"></a>

# 仅使用 Node 的运行时发布

[English](../node-runtime-rollout.md) | **简体中文** | [中文目录](README.md)

<a id="release-boundary"></a>

## 发布边界

M8 在最终黑盒能力审查后确立 Node 为唯一 npm 运行时。当前发布同时移除旧 Python 包、wheel、测试和工具链，只保留一个维护中的产品和一套发布检查。

当前 CLI：

- 交互使用时无条件启动 `startNodeBackend`。
- 拒绝已废弃的 `--runtime-backend` 参数。
- 忽略已废弃的后端选择环境变量。
- 不包含备用运行时启动、可执行文件探测或 wheel 路径。
- 沿用已有 TUI 和终端交互模型，不重新设计它们。

<a id="retained-surface"></a>

## 保留能力

M8 保留 provider 协议、对话/会话操作、审批、澄清、队列、压缩、记忆、文件工具、持久 Shell、集成、子 Agent、管理命令、doctor、诊断、信号、关闭流程和内置 slash 命令目录。

当前子 Agent 使用完全由 Node 监督的持久 Agent 线程。状态、邮箱投递、冻结权限、重启恢复、可读产物和 TUI 投影见 [node-agent-runtime.md](node-agent-runtime.md)。

移除旧运行时前的最终 gateway 基线包含 33 个 RPC 和 42 个事件。后续契约增加 Shell 控制和显式 `session.new`，形成本文记录的 38 个 RPC 和 42 个事件。脱敏 M2–M7 测试数据仍在 `tests/fixtures` 下，并由 M8 审查校验和保护。

Node 接口中有意移除：

- `LS`、`Glob` 和 `Grep`；有限范围发现由 `Read` 负责。
- 隐式子 Agent 预算；Node 预算需要主动启用。
- Python 插件源码兼容；Plugin API v2 使用编译后的 ESM。
- 同一构建中的备用后端回退。

仓库不再分发旧 Python 控制台脚本或包元数据。现有用户改用 npm 安装与启动命令；移除过程不迁移、重写或删除健康的 schema-v12 会话数据。

<a id="offline-release-gate"></a>

## 离线发布检查

从干净的 Node 安装运行：

```bash
npm ci
npm run contracts:check
npm run lint
npm run test:ci
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

CI 在 Linux、macOS、Windows 上使用 Node 22.19 和 Node 24 执行检查。打包冒烟测试创建工作区 tarball 及当前平台 ripgrep 包，安装到干净目录，检查编译 CLI 和原生 PTY，使用干净主目录执行管理命令，并将任何 Python 导入、调用或探测判为失败。发布所有平台包前，运行 `npm run smoke:package -- --all-platforms` 下载并检查全部六个 ripgrep 产物。

`smoke:m8` 不依赖 provider。它使用临时主目录和工作区启动真实后端，等待 `runtime.ready`，引导会话，加载含 16 个命令的可见 TUI 投影，然后关闭。审查测试另外固定全部 35 个内置命令，包括隐藏控制。输出仅为一行结构化 JSON，不含路径、提示词、凭据、端点、provider 数据或工具输出。

<a id="credential-gated-responses-smoke"></a>

## 需要凭据的 Responses 冒烟测试

只在离线检查通过后执行一次付费服务冒烟测试：

```bash
MYCLI_API_KEY=... \
MYCLI_BASE_URL=... \
MYCLI_MODEL=... \
MYCLI_PROVIDER=openai \
node scripts/smoke_node_m5_state.mjs --protocol responses
```

测试使用临时主目录/工作区/数据库、零重试、有限输出和脱敏结构化报告。缺少凭据或配置服务不可用返回 `77`；成功返回 `0`；结构失败返回 `1`。同一次发布验证中不要重试不可用的付费服务请求。

<a id="rollout-procedure"></a>

## 发布步骤

1. 升级生产工作站前备份 `~/.mycli`。
2. 完成或中断活动轮次，并处理待决审批/澄清。
3. 停止后台 Shell 和子任务。
4. 安装当前 npm 包并运行 `mycli doctor`。
5. 运行一个无需 provider 的管理命令和一个临时会话。
6. 只有离线检查通过才运行需要凭据的 Responses 冒烟测试。
7. 平台任务和清理检查通过后再推广发布。

不要让两个包版本同时操作同一个活动会话数据库。持久 schema 兼容不代表可以共享实时进程或继续执行的所有权。

恢复迁移会话前，doctor 报告必须包含健康的 `model_input_ledger` 项。这项只读检查检测不完整清单、缺失不可变引用、内容哈希不匹配和无效 provider 步骤生命周期链，不原地修复记录。账本损坏时从备份恢复，或继续使用先前版本。

<a id="failure-and-rollback"></a>

## 失败与回退

失败的 Node 轮次报告真实终态，不会通过其他运行时重放，否则可能重复 provider 调用、审批、文件修改、插件副作用或进程启动。

回退意味着重新安装上一个包版本；M8 构建没有后端选择器。回退前：

1. 完成或中断当前轮次。
2. 处理或拒绝待决用户输入。
3. 停止全部后台 Shell 和子 Agent。
4. 关闭 mycli 并备份 `~/.mycli`。
5. 安装先前版本。
6. 使用该版本的 doctor/status 检查目标会话后再恢复。

不要加入未公开的备用运行时或诊断性可执行文件探测。回退是由操作人员在轮次之间做出的包级决定，不是自动重试路径。

<a id="troubleshooting"></a>

## 故障排查

自动化使用 `mycli doctor --json`；TTY、provider、原生 PTY、沙箱、扩展、会话和关闭故障见 [troubleshooting.md](troubleshooting.md)。诊断输出必须保持有界，不包含凭据、请求头、提示词、命令、原始 provider 数据、原始工具输出或私有文件内容。
