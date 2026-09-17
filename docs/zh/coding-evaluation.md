<a id="coding-evaluation"></a>

# 编程评估

[English](../coding-evaluation.md) | **简体中文** | [中文目录](README.md)

`tests/fixtures/coding-evaluation/` 下带版本的任务集衡量三个小型流程：包含端点的范围修复、共享规范化契约，以及三层 AGENTS 指引。每个任务 JSON 的 SHA-256 固定在清单中。这些是初始回归任务，不是完整编程质量衡量，也不能证明 mycli 与其他 Agent 能力相当。

```bash
npm run build
npm run eval:coding -- --list
npm run eval:coding -- --run --model <model> --output results.json
npm run eval:coding -- --run --task layered-guidance --json
```

列出任务不启动 provider。真实执行需要明确 `--run` 和环境提供的 `MYCLI_API_KEY`；`MYCLI_PROVIDER`、`MYCLI_PROTOCOL`、`MYCLI_BASE_URL` 选择兼容 provider。凭据不接受 argv 传入，也不进入报告。任务默认 120 秒，`--timeout` 最多设为 3600 秒。真实调用可能产生 provider 费用，不属于 `npm test`。

每个任务使用全新临时 Git 仓库和主目录。运行器仅信任临时任务 cwd，提供测试文件和公开提示词，再调用 `mycli exec --json -`，不复制现有用户配置。嵌套指引任务从 `backend/service` 开始，因此必须从 Git 根发现上级指引。尝试结束后清理工作区和主目录，失败和取消也一样。源码仓库和用户信任存储不修改。

评估其他 Agent 时，`--agent-command <file>` 接受 JSON argv 数组，例如 `["/absolute/path/to/agent", "exec", "--json", "-"]`。直接执行不经过 Shell，通过 stdin 接收任务，使用隔离 cwd/home。按该 Agent 支持的环境变量配置，不继承已有主目录凭据存储。对比时使用相同任务 ID、数据集哈希和超时。只有识别的 JSONL 事件能产生工具/token 指标；缺失用量表示未知，不是零。

运行器用保存在 Agent 工作区外的断言评分导出行为和 JSON 产物，也检查 AGENTS 文件是否被修改。评分器在独立、有界、不带 provider 凭据的子进程运行，必须带每次运行的 token 返回全部预期检查；提前成功退出不算通过。这防止意外终止评分器，但不是防御恶意生成代码的安全沙箱。不受信任的 Agent 命令应放在操作系统隔离环境运行。

报告包含任务成功、检查结果、耗时、退出码、交互/工具数量，以及可用时 provider 报告用量，不包含提示词、Agent stdout/stderr 或秘密值。全部通过退出 `0`，评分失败为 `1`，运行器/输入错误为 `2`，中断为 `130`。

确定性仓库测试通过未修改的测试数据和模拟修复 Agent 验证评分、哈希变化、超时/输出限制及缺失评分结果，不联系模型。

<a id="system-prompt-behavior"></a>

## 系统提示词行为

`eval:prompt` 针对七个固定对话场景评估模型下一条响应：初始行动说明、重复 Shell 轮询、未完成工作期间的状态问题、独立 Shell 审批请求、缺少 skill、自然的中文 skill 声明，以及已经授权的写目录。

```bash
npm run eval:prompt -- --list
npm run eval:prompt -- --run --model <model>
npm run eval:prompt -- --run --model <model> --case repeated-shell-wait
```

真实执行需要 `MYCLI_API_KEY`，可通过 `MYCLI_PROVIDER`、`MYCLI_PROTOCOL`、`MYCLI_BASE_URL` 选择 provider。运行器不读取用户配置或凭据存储，使用当前源码提示词、真实工具 schema、运行时权限展示和 skill 目录指令。每个用例只发一次有界 provider 请求，默认 45 秒超时（`--timeout` 可设 1–120 秒），最多 2048 输出 token。

所有路径、对话历史和工具结果均为合成数据。提议的工具调用只验证评分，不执行。报告含用例 ID、检查结果、耗时、模型标识和提示词/数据集哈希，不含响应文本、工具参数或凭据。数据集固定在 `tests/fixtures/system-prompt-evaluation/manifest.json`，列出无需 provider。

检查要求预期后续操作、符合 schema 的参数、完整响应，以及适用时工具调用前使用用户语言的文本。这些是局部行为检查，不是完整语言质量或端到端 TUI/审批测试；审批调度由已有 Shell 集成套件覆盖。确定性评分测试使用脚本响应，不能证明真实模型遵循提示词。真实结果与 `npm test` 分开，可能收费，只适用于被测模型。

打包提示词版本为 `2026-09-codex-style-base-v18`。重新构建、重启 mycli 并创建新会话，才使用更新的基础指令。已有会话保留冻结指令快照，不重写。

Shell 使用 `sandbox_permissions="require_escalated"` 时，模型通过用户语言的审批问题提供 `justification`，解释具体操作及额外访问需要。普通调用省略。本文对应的审批 UI 显示一个可选 `Reason`：运行时原因优先，其次模型理由；两者都没有则不显示。正常审批不会额外调用模型生成原因。

基础提示词优先用 Edit/Patch/Write 手动改文件。专用工具不可用、操作失败或不适合时，模型可用 Shell 或其他可用方式。项目生成器、格式化器、lint 自动修复和批量机械修改脚本可直接运行，不必先让文件工具失败。范围应明确，结构化数据使用结构化 API，失败后检查部分改动，并验证最终 diff。所有方式都遵守当前模式、权限和审批决定。

受支持文件优先用 Read。它不可用、操作失败或不支持格式时，可在相同许可范围内使用有界 Shell 读取或适当解析器。限制路径、提取范围和输出大小，不输出无限文件或原始二进制。

传给 Shell 的字面内容需要 Shell 引用，JSON 转义不够。多行内容可使用受支持、不冲突分隔符的带引号 heredoc 或结构化文件 API。目标文件重叠的修改必须串行，并在完成后执行依赖的读取、构建或测试。独立 Shell 命令和审批请求保留并行行为。脚本修改必须验证目标文件、替换匹配和实际 diff，不能仅凭零退出码判断。零匹配时，应确认目标状态是否已存在或调查不匹配原因，再宣称成功。
