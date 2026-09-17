<a id="testing-mycli"></a>

# 测试 mycli

[English](../testing.md) | **简体中文** | [中文目录](README.md)

mycli 使用一份仓库测试目录，区分快速反馈、跨层行为、依赖宿主环境的行为和发布验证。目录定义在 `scripts/test-suite-catalog.mjs`；`scripts/run-test-suite.mjs` 是仓库根目录唯一的 Node 测试编排入口。

<a id="test-suites"></a>

## 测试套件

| 套件 | 用途 | 常规依赖 |
| --- | --- | --- |
| `unit` | 确定性的进程内领域、服务、存储和无界面 TUI 行为 | Node 和临时文件 |
| `contract` | JSON Schema、生成的声明、固定测试数据、包元数据和仓库一致性 | 当前源码；部分包检查会读取 `dist/` |
| `integration` | 本地 HTTP、Worker、子进程、扩展、恢复和并发边界 | 回环网络和本地子进程 |
| `platform` | 原生 PTY、宿主 Shell、进程传输和平台专用执行 | 支持的宿主平台和原生依赖 |
| `release` | 版本管理、打包、兼容性策略和发布流程检查 | 仓库发布元数据 |
| `smoke` | 针对构建或打包产物、无需 provider 的可执行流程 | 最新构建及平台依赖 |

真实 provider 检查不属于 `npm test`。它们是需要显式启用并提供凭据的冒烟测试，只能输出脱敏后的结构性证据。

<a id="commands"></a>

## 命令

```bash
npm run test:list
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:platform
npm run test:release
npm run test:ci
npm run test:smoke
npm run test:smoke:live -- --dry-run
```

`npm test` 与 `npm run test:ci` 是等价的确定性仓库检查。`pretest` 生命周期先构建每个工作区一次，然后依次运行单元、契约、集成、平台和发布套件。单独运行某个套件不会执行完整构建；源码变化后，如果需要验证编译输出或包元数据，应先运行 `npm run build`。

在 `--` 后传入受支持的 `node:test` 参数：

```bash
npm run test:integration -- --test-name-pattern="queue|worker"
npm run test:list -- --json
```

<a id="classification-rules"></a>

## 分类规则

- 普通 `*.test.ts` 或 `*.test.mjs` 文件属于其目标的默认套件。运行时工作区默认为 `unit`；contracts 工作区和仓库测试目录默认为 `contract`。
- 整个文件都对应某种边界时，使用 `*.integration.test.ts`、`*.platform.test.ts` 或 `*.contract.test.ts`。
- 现有的混合文件或旧文件名使用目录中少量明确的覆盖规则。覆盖规则引用不存在的文件会导致目录发现失败，避免遗留条目不断积累。
- 无需 provider 的冒烟流程放在 `scripts/smoke_*.mjs`，不伪装成普通 `node:test` 文件。真实 provider 流量始终需要主动启用。
- 每个测试使用框架提供的临时目录，并负责清理自己创建的文件、端口、进程、Worker、终端和数据库。
- 各包自己的 `npm test` 仍可用于针对性检查。仓库根目录和 CI 使用统一目录，确保每个仓库测试恰好被选择一次。

<a id="ci-and-release"></a>

## CI 与发布

Pull request CI 在 Linux、macOS 和 Windows 上，使用 Node 22.19 与 Node 24 运行 `test:ci`。平台任务会在 `test:platform` 前安装原生依赖。无需 provider 的 M8 和打包产物冒烟检查仍是独立步骤，因为它们验证的是可执行产物，而不是测试模块。

主分支的真实服务冒烟测试只在确定性检查通过后运行。发布 CI 还会在发布前验证兼容性策略、所有平台打包产物、旧版本升级和降级行为，以及发布元数据。

`test:m2` 到 `test:m8` 保留为排查历史里程碑的兼容快捷命令。它们不是独立 CI 门禁，对应文件已经归入标准套件。

<a id="maintaining-the-suite"></a>

## 维护测试套件

新增测试前，按执行边界而非产品里程碑选择归属。优先让一个文件只覆盖一个领域，将包内辅助函数放在 `test/support`。不要把可复用的生产逻辑移入测试辅助函数，也不要再手工维护第二份完整测试文件清单。

大型混合文件应按现有职责边界拆分，并保留测试名称和测试数据。优先处理 gateway 的队列、审批和会话行为、后端组装、运行时轮次执行、TUI Shell 交互，以及 TUI 对话投影。拆分属于后续机械整理；统一目录会在此期间保持套件归属稳定。
