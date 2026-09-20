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

1. `MYCLI_SHELL_PATH`，裸命令名会通过 `PATH` 解析
2. PowerShell 7（`pwsh.exe`）
3. Windows PowerShell 5.1（`powershell.exe`）
4. 命令提示符（`cmd.exe`）

模型看到的是统一的跨平台 `Shell` 契约和相关输入/输出控制工具，不会分别获得 Bash、PowerShell 和 CMD 的 schema。
环境上下文会报告当前 Shell 家族和方言，模型据此编写该 Shell 真正能执行的命令。

也可以在单个进程内临时覆盖：

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\PowerShell\7\pwsh.exe"
npm run mycli
```

不存在的绝对路径、以及不在 `PATH` 中的裸命令名都会被忽略，随后继续自动检测。`mycli doctor` 会报告所选 Shell 与方言，不暴露命令或环境变量值。

Shell 输出固定为 UTF-8：CMD 命令会在 `chcp 65001` 之后执行，PowerShell 命令会在命令文本之前设置 `[Console]::OutputEncoding` 和 `$OutputEncoding`。仍然以控制台代码页输出的内容（例如 CP936 主机上的旧式控制台程序）会按该代码页解码，而不是退化成替换字符。

CMD 是最后一个受支持的回退选项。它的审批解析器有意保持保守：展开、重定向、管道、命令串联或未知语法都可能需要确认。PowerShell 审批解析器接受引号路径前的 `&` 调用运算符。

<a id="pty-and-sandbox"></a>

## PTY 与沙箱

交互式 Shell 会话使用 `node-pty` 和 ConPTY。受限进程配置使用包内的 `backend/packages/tools/native/windows/mycli-windows-sandbox.exe`，源码位于 `native/windows-sandbox-helper`。辅助程序缺失或无效时返回 `sandbox_unavailable`，不会无限制运行命令。

支持 PSEC（Process Security Environment）且没有旧版安装状态的 Windows 主机会优先使用新后端，状态显示 `isolation=windows_psec`。setup 只初始化本地状态，不需要 UAC、专用账户、修改第三方 ACL 或持久防火墙规则。检测会实际创建安全环境并验证进程启动属性，不只检查系统版本。已记录的 PSEC 安装在能力消失时会拒绝执行，不会静默降级。

旧系统及已有账户后端安装继续使用 `windows_restricted_token`，初始化普通联网、离线和代理三个专用账户，需要 UAC。下文涉及账户、ACL、防火墙的维护说明适用于该旧后端。PSEC 的 reset 拒绝活动命令；repair/uninstall 会停止活动命令、清理已记录的状态和空占位目录，无需提权。

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

Read Only 禁止工作区写入并默认离线；Workspace 只允许写入配置的可写根目录，默认允许联网。PSEC 为每个命令建立独立网络策略；旧后端通过三个专用账户及 WFP 实现联网、离线和代理隔离。支持的 HTTP/HTTPS 流量见 [网络策略](network-policy.md)。

`.git`、`.agents` 和 `.codex` 路径禁止写入；这些元数据路径若是 junction 或符号链接，会拒绝执行。普通 junction 不会授予工作区外的写权限。旧后端仅保护已有元数据，PSEC 还预留尚未存在的元数据名称。PSEC 支持自定义进程可读目录及“不限文件系统但限制网络”的组合，旧账户后端仍会拒绝这些请求。网络无限制且没有显式文件限制的 Full Access 在宿主上运行。

<a id="verification"></a>

## 验证

PSEC 后端已在本机 Windows 11 上执行真实隔离验证。旧 Windows 后端仍需独立验收，本机重新 setup 也不能代替干净系统安装证据。各项检查的实际结果与未完成的发布条件见[本地验证记录](../parity/windows-sandbox-local-verification.md)。

编译 helper 后，可运行 `npm run sandbox:check-host` 做只读预检。PSEC 检查环境创建和启动属性；旧后端报告 NULL DACL 阻塞和扫描不完整情况。两者都不修改第三方权限，也不代表完整验收通过。

### PSEC 的兼容性与边界

可以在 `~/.mycli/managed_config.toml` 中配置：

```toml
[execution_policy]
readable_roots = ['C:\shared']
readonly_roots = ['C:\repo\vendor']
allow_local_binding = false
writable_tmp = true
```

可读目录在平台运行目录之外增加读取权限；只读目录即使位于可写根目录内也禁止修改，文件工具审批和子任务都不能删除这项限制。旧账户后端会拒绝这些 PSEC 选项。

显式启用 `allow_local_binding` 后，代理模式允许访问所有 IPv4/IPv6 本机回环端口，包括域名代理之外的本地服务。默认仍只放行本命令的代理端口，离线策略仍优先。已验证端口绑定及沙箱向宿主的连接；宿主主动连入沙箱服务在本机失败，尚未通过验收，详见[功能对齐记录](../parity/windows-sandbox-feature-parity.md)。

Workspace/Full 请求默认提供独立的 `TMPDIR`，Read Only 默认关闭。`writable_tmp=false` 只关闭这份额外目录，Windows PSEC 自己仍会提供私有 `TEMP/TMP`，不会开放宿主临时目录。最后一个活动命令退出后清理记录的目录；helper 异常退出后，下次运行会恢复清理。

“不限文件系统但限制网络”会为可访问逻辑盘及其直接子项建立授权快照，在应用限制前解析支持的本地 junction／符号链接目标，保留显式只读、禁读及工作区元数据保护。不承诺访问不可读、共享锁定、任意 UNC 路径或卷 GUID 重解析目标。大策略通过有界环境载荷传递，最多 1,000,000 UTF-8 字节，执行工作负载前移除载荷变量。

原生 helper 支持显式本地 junction／符号链接根目录，在命令运行期间锁定收到的链接链和目标路径，并按文件句柄取得真实路径，让 8.3 短文件名与真实目录使用相同的并发策略标识。最多解析 32 次链接跳转、持有 16,384 个句柄；循环或不支持的重解析类型会拒绝执行。Node 适配层原本就会先规范化策略根目录；保护树内部的重解析点仍会拒绝。命令完成后先释放句柄，再清理记录的占位目录。

并发支持相同策略或写入范围互不干扰的独立策略。读取、只读和禁读范围一致，且写入根目录都在共同的递归读取范围内时，无可写根目录的命令也可与写入命令同时运行；只读一方仍不能写文件或创建硬链接。重叠且不同的写策略、混合整盘策略仍会拒绝，以防硬链接竞态。

PSEC 在 NULL DACL 路径上仍限制文件访问，离线命令无法发送网络流量，域名模式默认只放行分配给该命令的 IPv4 loopback TCP 代理端口。UDP 验证检查实际接收量及应答，不能把发送调用成功当作数据已送达。

读取范围包含工作区、Windows、Program Files、ProgramData、现有绝对 PATH 目录及命令所在目录，不为工具启动而开放整盘读取。私有兄弟文件保持不可读。禁读规则覆盖现有硬链接别名；跨可写边界的硬链接会在启动前拒绝。保护目录中的重解析点、无法检查的路径、别名枚举失败或超过 250,000 个扫描条目都会阻止执行。尚不存在的元数据路径会临时预留，只清理本次创建且仍为空的目录。

可写根在启动时不做枚举。宿主机预先放在可写根里的硬链接别名会被接受，通过它写入会作用到别名指向的文件上；这与 shipped Codex 的 Windows 沙箱行为一致。PSEC 仍然拒绝在沙箱内创建任何链接，因此只有沙箱外的行为者才能引入这种别名。启动准备不再随工作区大小变慢。

Windows PowerShell 使用以工作区为根的内部 `MycliWorkspace:` 驱动器，原生进程仍获得真实工作目录。Node 固定使用 `--preserve-symlinks --preserve-symlinks-main`，避免模块加载扫描私有父目录；依赖默认符号链接规范化行为的项目需要兼容性测试。文件的最终目标仍受 PSEC 检查。

这属于可信宿主上的进程隔离，不防御管理员、已被攻陷的内核或故意并发篡改工作区的宿主进程。一次 `ready` 不能代替原生、Shell/ConPTY、网络及安装包验收。

```powershell
npm run contracts:check
npm test
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

在 Windows 开发机上单独验证沙箱：按[原生 helper 文档](../../backend/packages/tools/native/windows/README.md)编译并放置辅助程序，然后运行：

```powershell
npm run dev -- sandbox setup --confirm
if ($LASTEXITCODE -ne 0) { throw "Sandbox setup failed" }
npm run dev -- sandbox status
if ($LASTEXITCODE -ne 0) { throw "Sandbox is not ready" }
$env:MYCLI_WINDOWS_SANDBOX_SETUP_TESTS = "1"
$env:MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS = "1"
npm run test:windows-sandbox
if ($LASTEXITCODE -ne 0) { throw "Windows isolation tests failed" }
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
其他平台暂不支持这些进程限制，会拒绝启动而非忽略配置。Windows 旧后端不支持自定义读取根；PSEC 支持在平台读取范围之外添加读取根。

每个 Windows runner 使用独立的私有桌面，子进程通过实际登录 SID 或准确的 PSEC 容器 SID 获得该桌面的权限。
旧后端在启动前还会有界检查常见目录的 Everyone 写权限，在允许写入范围外添加专用 capability 的写入拒绝。
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

2026-09-17 的账户后端曾被宿主 NULL DACL 阻挡；PSEC 的当前验收结果见[本地验证记录](../parity/windows-sandbox-local-verification.md)。没有更改该第三方目录的权限。
维护集成测试还需设置 `MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS=1`，仅在可丢弃的 Windows 环境启用。
正式发布验收必须同时启用上述维护测试和 `MYCLI_WINDOWS_SANDBOX_SETUP_TESTS=1`，验证重置、修复、卸载与重新安装。
可在 Windows 开发机上按原生 helper 文档运行，无需触发 GitHub CI；编译、原生测试和完整集成测试全部通过后，才能采用该 helper 发布。

`test:windows-sandbox` 强制要求原有 13 项全部通过；使用 PSEC 时还必须通过新增 7 项测试。跳过、取消或 todo 均视为失败。PowerShell 5.1 的 `$ErrorActionPreference` 不能自动捕获原生命令的非零退出码，必须逐步检查 `$LASTEXITCODE`，失败即停止。NULL DACL 表示允许所有人访问，与拒绝访问的空 ACL 不同；不能通过屏蔽审计或修改第三方目录权限绕过失败。

原生和平台测试通过后，`npm run smoke:package -- --require-windows-ready` 会检查已安装候选包的 helper 和 `ready` 状态。干净 Windows 环境还需添加 `--setup-windows-sandbox`：先确认没有受管状态，再执行确认安装，最后独立检查就绪状态。更换 HOME 或 npm 安装目录不能隔离机器账户、ACL 和网络规则。发布流程要求这一独立 Windows 安装门槛通过，并发布实际测试的同一个 tarball，操作见[发布说明](releasing.md)。
