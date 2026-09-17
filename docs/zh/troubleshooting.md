<a id="troubleshooting"></a>

# 故障排查

[English](../troubleshooting.md) | **简体中文** | [中文目录](README.md)

先运行不依赖 provider 的诊断：

```bash
npm run mycli -- doctor
npm run mycli -- doctor --json
```

Doctor 读取配置、存储、包契约、进程支持和扩展状态。默认命令和 `--fix` 预览不会调用模型 provider，也不会修复文件。只有预览内容未变化时，才应使用 `mycli doctor --fix --confirm <plan-id>` 应用它。使用 `mycli doctor --support-bundle` 可以生成供离线支持使用的私有脱敏文件；mycli 不会上传该文件。

<a id="interactive-ui-does-not-start"></a>

## 交互界面无法启动

- 确认 `node --version` 至少为 22.19。
- 确认 stdin 和 stdout 均连接到真实终端。交互启动有意拒绝管道输入输出；管理命令仍可用于非 TTY 自动化。
- 运行 `npm run build` 后再启动编译入口；过时的 `dist` 可能仍包含旧帮助或导入。
- 按一次 Ctrl+C 中断活动轮次；只有界面显示退出提示时才按第二次。

<a id="provider-failure"></a>

## Provider 失败

- 将 `MYCLI_PROVIDER`、`MYCLI_PROTOCOL`、`MYCLI_MODEL` 和 `MYCLI_BASE_URL` 作为一组检查。
- 确认存在 `MYCLI_API_KEY` 或配置的 `auth_ref`，但不要打印其值。
- Responses 端点必须支持所选模型的请求和流式事件格式。兼容 Chat Completions 的端点必须配置为 `chat_completions`。
- 排查时明确设置重试上限。同一次验证中，如果冒烟请求因服务不可用以 `77` 退出，不要反复发出付费请求。

<a id="native-pty-failure"></a>

## 原生 PTY 失败

- 使用 `npm ci` 按锁文件重新安装。
- 没有可用的预编译 `node-pty` 二进制时，安装平台编译依赖并重新执行 npm 安装。
- 运行 `npm run smoke:package`，通过干净的打包安装验证 PTY。
- Windows 上确认 ConPTY 可用，并使用 PowerShell 7、Windows PowerShell 或 CMD。

<a id="sandbox-unavailable"></a>

## 沙箱不可用

- 先运行 `mycli sandbox status`，自动化场景可加 `--json`。
- macOS 的受限配置需要可执行的 `/usr/bin/sandbox-exec`。请通过操作系统恢复它；mycli 不安装或替换系统组件。
- Linux 的受限配置同时需要可执行的 `bwrap` 和可用的 user、PID、network namespace。mycli 会执行有时间限制的只读能力探测，因此即使二进制存在，容器或 CI 宿主仍可能报告 `enforcement_unavailable`，例如 namespace 或回环网络设置被拒绝时。需要启用宿主/容器相应能力，或改用兼容 runner；单纯重装 bubblewrap 无法解决这类问题。mycli 不会调用包管理器。
- Windows 的受限配置需要包内的 `mycli-windows-sandbox.exe`。
- 首次使用时，批准 Windows UAC 提示，以便初始化专用沙箱身份和离线防火墙策略。取消或安装失败会继续阻止命令；重试受限命令会再次启动安装。
- 显式恢复时，先运行 `mycli sandbox setup`，审查权限与影响预览，再加 `--confirm` 执行。Windows 状态损坏时，预览 `mycli sandbox repair` 后加 `--confirm`，停止沙箱进程、清理已记录的 ACL 并重建安装。reset 要求没有活动 helper，清理记录的 ACL、安装标记和凭据，保留账号及网络限制；若要一并移除专用账号和网络规则，先预览 `mycli sandbox uninstall`，详见 [Windows 维护](windows.md)。
- 使用 `mycli doctor --verbose` 查看稳定的就绪/恢复代码。CLI 的人类可读和 JSON 输出都不会包含原生 stderr、可执行文件路径、堆栈或安装凭据。
- 隔离不可用时拒绝执行。只有用户明确选择时才使用 `danger-full-access`，不要用无沙箱回退替换辅助程序。

<a id="session-or-pending-input-recovery"></a>

## 会话或待处理输入恢复

- 不要让两个 mycli 进程同时操作同一个活动会话。
- 等前一个进程退出并释放所有者记录后再恢复。
- 重启后会重新发出待处理的审批或澄清请求。请响应界面上同一个请求，而不是提交新轮次。
- 恢复后效果状态为 `unknown` 的操作不会自动重放；继续前先检查改动和日志。
- 维护或回退安装包前，备份 `~/.mycli`。

<a id="slash-command-failure"></a>

## Slash 命令失败

- 用 `Ctrl+P` 打开可搜索命令面板，使用 `/help` 查看快捷键和命令分组；隐藏别名与参数规则见 [commands.md](commands.md)。
- 标记为轮次执行期间不可用的命令，必须等当前轮次结束后再运行。
- M8 不再接受旧的 `--runtime-backend` 参数。应删除该参数，而不是替换其值。

<a id="removed-python-entrypoint"></a>

## 已移除的 Python 入口

旧 Python 控制台脚本和 wheel 已不再分发。使用 `npm ci` 安装依赖、`npm run build` 构建，并通过 `npm run mycli` 启动。移除 Python 入口这一步不提供兼容回退，也不要求手动迁移会话数据。

<a id="upgrade-or-compatibility-gate-failure"></a>

## 升级或兼容性检查失败

- 更换包或会话版本前，阅读 [compatibility.md](compatibility.md)。
- 运行 `npm run release:compatibility` 检查本地策略和文档是否一致。
- 运行 `npm run smoke:package`，将候选产物问题与 npm 注册表可用性区分开。
- 依赖注册表的 `npm run smoke:release-compatibility` 仅在明确的外部注册表/网络阻塞时返回 `77`。其他非零退出码都表示产品或测试数据失败，不能忽略。
- 应用配置迁移必须使用最新预览的准确版本。使用返回的备份 ID 回退，不要手动编辑迁移备份文件。
- 包名替换和安全降级会话的步骤见 [upgrading.md](upgrading.md)。

<a id="extension-failure"></a>

## 扩展失败

- 启动交互运行时前，使用 `hooks/plugins/mcp/subagents list --json`。
- 不会执行原始 TypeScript 或 Python 插件源码。请将 Plugin API v2 入口编译为 ESM。
- 旧 Python 插件会报告 `migration_required`；请按 [migration/python-plugins-to-v2.md](migration/python-plugins-to-v2.md) 迁移。
- 扩展启动、超时、协议和能力错误会被隔离，且信息大小受限。应检查稳定分类，不要暴露 Worker 的 stdout/stderr 或环境变量值。

<a id="safe-diagnostic-sharing"></a>

## 安全分享诊断

分享 doctor 的状态/分类和命令退出码即可。不要分享 API Key、认证文件、请求头、提示词、provider 响应、原始工具输出、Shell 命令、私有路径、会话数据库内容或插件环境变量值。
