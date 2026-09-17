<a id="windows-source-checkout"></a>

# Windows 源码安装

[English](../windows.md) | **简体中文** | [中文目录](README.md)

mycli 通过 Node.js 在 Windows 上原生运行。通过 npm 安装的 CLI 不需要 Git Bash 或额外的语言运行时。

<a id="requirements"></a>

## 环境要求

- Node.js 22.19 或更新版本；支持 Node 24。
- npm 和 Git。
- 仅在 npm 无法使用预编译二进制、必须编译原生依赖时，才需要 Visual Studio Build Tools。

在 PowerShell 中安装和运行：

```powershell
npm ci
npm run build
npm run mycli
```

<a id="shell-selection"></a>

## Shell 选择

mycli 按以下顺序检测命令运行环境：

1. PowerShell 7（`pwsh.exe`）
2. Windows PowerShell 5.1（`powershell.exe`）
3. 命令提示符（`cmd.exe`）

模型看到的是统一的跨平台 `Shell` 契约和相关输入/输出控制工具，不会分别获得 Bash、PowerShell 和 CMD 的 schema。

可以在 `~/.mycli/config.toml` 中指定 Shell：

```toml
[shell]
path = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
```

也可临时覆盖：

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\PowerShell\7\pwsh.exe"
npm run mycli
```

无效路径和未知可执行文件会被忽略，随后继续自动检测。`mycli doctor` 会报告所选 Shell，不暴露命令或环境变量值。

CMD 是最后一个受支持的回退选项。它的审批解析器有意保持保守：展开、重定向、管道、命令串联或未知语法都可能需要确认。

<a id="pty-and-sandbox"></a>

## PTY 与沙箱

交互式 Shell 会话使用 `node-pty` 和 ConPTY。受限进程配置使用包内的 `backend/packages/tools/native/windows/mycli-windows-sandbox.exe` 辅助程序，其源码位于 `native/windows-sandbox-helper`。辅助程序缺失或无效时返回 `sandbox_unavailable`，不会无限制运行命令。首个受限命令会初始化三种独立的本地沙箱身份，分别用于普通联网、离线执行和域名代理。Windows 为这次初始安装显示 UAC 提示；mycli 会等待完成并验证，再执行命令。

无需启动 TUI 或 provider，也可以检查或恢复同一状态：

```powershell
mycli sandbox status
mycli sandbox setup
mycli sandbox setup --confirm
mycli sandbox reset
mycli sandbox reset --confirm
mycli sandbox repair
mycli sandbox repair --confirm
mycli sandbox uninstall
mycli sandbox uninstall --confirm
```

不带 `--confirm` 时，setup、reset、repair 和 uninstall 只预览影响。确认安装后可能显示 UAC；取消会保持命令阻塞，并报告 `operation_canceled`。确认重置不会删除专用账号，也不会移除防火墙/WFP 限制，清理已记录的文件 ACL 后，清除加密凭据和安装标记；仍有沙箱命令运行时拒绝 reset。因此，下一次确认安装或有效受限命令可以安全轮换凭据并验证保留的限制。`status` 和 `mycli doctor --verbose` 显示大小受限的类型化代码；CLI 不打印原生辅助程序输出、本地路径或堆栈。

Read Only 禁止工作区写入并默认离线；Workspace 只允许写入配置的可写根目录，默认允许联网。联网与离线命令使用不同账户，并发运行不会改变彼此的网络权限。域名限制使用第三个账户，WFP 只允许当前登录身份连接自己的运行时代理端口。支持的 HTTP/HTTPS 流量见 [网络策略](network-policy.md)。

已有的 `.git`、`.agents` 和 `.codex` 路径禁止写入；这些元数据路径若是 junction 或符号链接，会拒绝执行。普通 junction 不会授予工作区外的写权限。Windows ACL 保护已有对象，不预留尚未存在的元数据名称。任意进程读取白名单，以及“不限文件系统但限制网络”的组合，会在启动前拒绝。网络无限制的 Full Access 按其含义在宿主上运行。

<a id="verification"></a>

## 验证

当前沙箱改动仍在进行 Windows 集成验证。此前版本的原生编译、协议测试、受限 token 基础测试和初始化已在 Server 2022、2025 上通过，但完整的 Shell/ConPTY/域名代理测试尚未通过。最新的私有目录权限和终端启动修复尚未在 Windows 上重新编译和实测，当前不能视为可发布状态。

```powershell
npm run contracts:check
npm test
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

在 Windows 开发机上单独验证沙箱：按[原生 helper 文档](../../backend/packages/tools/native/windows/README.md)编译并放置辅助程序，然后运行：

```powershell
mycli sandbox setup --confirm
node --conditions=mycli-source --import tsx --test backend/packages/tools/test/sandbox/windows-sandbox.platform.test.ts
```

默认不执行重置和重新初始化测试。只有设置 `MYCLI_WINDOWS_SANDBOX_SETUP_TESTS=1` 才会启用；这类测试会轮换沙箱账号凭据，只应在可丢弃的测试环境中运行。

CI 在 Windows 上覆盖 Node 22.19 和 Node 24，并在 Windows Server 2022、2025 上编译和测试沙箱协议、受限 token、文件和网络策略。测试经过真实 Node Shell、原生 helper 和 ConPTY，覆盖中文/短路径、并发联网与离线、域名代理隔离、进程树清理、重置后重新初始化。发布用的 helper 也必须通过同一套验证。发布兼容性使用稳定的 `windows-2022` 镜像，安装打包候选版本并上传脱敏的结构性证据文件，不记录本地路径、命令、凭据、provider 内容或原生辅助程序 stderr。

升级或降级包时，先关闭所有 mycli 窗口，备份 `%USERPROFILE%\.mycli`，再按 [upgrading.md](upgrading.md) 操作。沙箱机器状态不属于 npm 或配置回退范围；更换版本后请运行 `mycli sandbox status`。

## 禁读规则、桌面隔离与维护

Windows helper 协议 v2 支持托管禁读规则。在 `~/.mycli/managed_config.toml` 中配置：

```toml
[execution_policy]
denied_read_roots = ['C:\Users\you\private', 'C:\work\project\secrets']
denied_read_globs = ["**/.env", "**/.env.*", "**/secrets/**"]
```

精确路径必须是绝对路径；glob 使用正斜杠，相对当前工作区匹配，包含隐藏文件。
每次启动前生成匹配快照，最多扫描 2 秒、50,000 个条目、匹配 1,024 个路径；超限会阻止启动，
大型目录建议使用精确路径。glob 不递归扫描目录链接，应将其真实目标加入精确路径。
新建的 glob 匹配项在下次启动时生效。尚不存在的精确路径会预留为受保护目录。
沙箱命令不能读取、修改或删除后重建受保护对象。

规则同时传递给 Shell、stdio MCP、插件和 Hook 子进程、Read、view_image、文件修改预览及子代理。
临时授权和 Full Access 不会移除托管禁读规则；存在禁读规则时使用受限文件系统模式。
其他平台暂不支持这些进程限制，会拒绝启动而非忽略配置。Windows 任意读取白名单仍不受支持。

每个 Windows runner 使用独立的私有桌面，受限子进程通过实际登录 SID 获得该桌面的权限。
启动前还会有界检查常见目录的 Everyone 写权限，在允许写入范围外添加专用 capability 的写入拒绝。
检查会跳过重解析点和无法读取的 ACL，不能视为全盘审计；发现风险后无法应用拒绝规则时阻止启动。

ACL 修改在应用前记录到受保护的状态文件中，并通过打开的文件句柄防止路径被替换。
禁读快照相同的命令可以并发；仍有沙箱进程运行时不能更换禁读快照，应先停止相关 Shell/MCP。
没有活动 helper 后，下次启动会清理旧规则。清理仅涉及 mycli 专用 SID 的记录及已记录的 WFP 权限位，
保留其他主体和权限；引入记录机制之前的旧 helper 修改无法完整追溯。

`mycli sandbox repair --confirm` 会停止沙箱进程、清理失效 ACL、更新凭据和网络规则，并重新验证就绪状态，
不会重放用户命令。`mycli sandbox uninstall --confirm` 会停止 helper、禁用专用账户并终止其残留进程，
再清理 ACL、WFP 授权、防火墙/WFP 规则、专用账户及其系统配置目录和已知状态文件。
它不会递归删除工作区或状态目录；预留目录仅在为空时移除。失败时保留恢复记录，便于重试。
不会仅凭用户名重置或删除无法确认归属的账户；卸载成功还必须验证专用账户和状态标记均已消失。

最新原生代码还需要 Windows 上的 MSVC 编译和实机验证；本地交叉编译不能替代该门禁。
维护集成测试还需设置 `MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS=1`，仅在可丢弃的 Windows 环境启用。
正式发布验收必须同时启用上述维护测试和 `MYCLI_WINDOWS_SANDBOX_SETUP_TESTS=1`，验证重置、修复、卸载与重新安装。
可在 Windows 开发机上按原生 helper 文档运行，无需触发 GitHub CI；编译、原生测试和完整集成测试全部通过后，才能采用该 helper 发布。
