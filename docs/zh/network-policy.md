<a id="shell-network-policy"></a>

# Shell 网络策略

[English](../network-policy.md) | **简体中文** | [中文目录](README.md)

默认的 Workspace（Ask for approval）配置允许 Shell 和 `web_fetch` 联网，无需另行申请网络授权。文件写入仍限制在工作区内，风险命令仍需审批。Read Only 默认离线；Full Access 也允许联网。更新后需重启 mycli，让新轮次使用这些默认值。

在 macOS 和 Windows 上，mycli 可以通过本地代理转发受域名限制的 Shell HTTP/HTTPS 流量，操作系统沙箱会阻止直接联网。网络访问仍需由当前权限配置或已批准的权限请求授权。

<a id="configure-allowed-domains"></a>

## 配置允许的域名

现有托管策略文件为 `~/.mycli/managed_config.toml`：

```toml
[execution_policy]
network = "enabled"
allowed_network_domains = ["api.github.com", "github.com", "*.githubusercontent.com"]
```

将这些字段合并到现有托管策略中，重启 mycli 后生效。托管设置用于限制权限。Workspace 已默认联网，上面的列表会限制目的地址，不需要额外授权。`network = "enabled"` 不会提升离线 Read Only 配置的权限。授权和 Shell 提权仍受托管列表限制，Full Access 也不例外。

精确条目只允许对应主机名。`*.example.com` 允许子域名，不包含 `example.com` 本身。应列出重定向所需的所有目的域名。空列表或 `network = "disabled"` 会让命令保持离线。省略列表表示不限制域名，但普通权限配置的网络策略仍然生效。

源码安装更新后，运行 `npm run build`，再用 `npm run mycli` 启动编译后的 CLI。无需单独的代理服务或代理配置。

## SOCKS5、上游代理和限制模式

在同一托管文件中，配合 `allowed_network_domains` 添加：

```toml
[execution_policy.network_proxy]
mode = "full"
enable_socks5 = true
allow_upstream_proxy = false
```

不添加这段配置时，保持原有 HTTP/CONNECT 行为。添加后默认值如上。SOCKS5 CONNECT 使用同一个受控回环端口，`ALL_PROXY` / `all_proxy` 设置为 `socks5h://`，让客户端把域名交给代理解析。full 模式支持公网 TCP 自定义端口；SSH 客户端配置 SOCKS5 后也能使用。IPv4/IPv6 地址需要单独列入允许列表，客户端自行解析出的 IP 不会自动获得域名权限。BIND、UDP ASSOCIATE 和私有地址仍被拒绝。

设置 `allow_upstream_proxy = true` 后，代理会读取**宿主**环境中的上游代理配置。HTTP 依次读取 `http_proxy`、`HTTP_PROXY`、`all_proxy`、`ALL_PROXY`；HTTPS 优先读取 `https_proxy` / `HTTPS_PROXY`，然后是 ALL 系列，最后是 HTTP 系列。支持 `http://` 和 `https://`，可带 Basic 认证；对应变量未配置时仍直接连接。凭据只保存在宿主内存，不传给子进程，也不写入权限快照。子进程只拿到 mycli 的本地代理地址，`NO_PROXY` 被清空。

连接上游前，mycli 仍会检查域名和公网 DNS 结果，并向上游发送已检查过的**数字地址**作为 CONNECT 目标；普通 HTTP 也使用 CONNECT 到 80 端口。上游必须支持这种方式，拒绝连接时不会回退直连。HTTPS 上游必须提供可信证书。只在上游内部能解析的域名不支持；stdio MCP 从宿主进程读取上游环境配置。

设置 `mode = "limited"` 后，只放行 GET、HEAD、OPTIONS。对 HTTPS 也会实际检查请求：本地代理解密 TLS，检查方法、Host 和 SNI，再与目标服务器建立独立验证证书的 TLS 连接。HTTPS 只支持 443 端口的 HTTP/1.1，limited 模式下 SOCKS5 也只接受该流量。POST、PUT、PATCH、DELETE、嵌套隧道和协议升级都会被拒绝，因此 Git push 和不少 API 调用会受影响。GET 方法本身也不能保证远程服务没有副作用。

限制模式通过 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE` 和 `GIT_SSL_CAINFO` 给对应子进程提供临时**公开 CA 证书包**，签名私钥只留在内存，进程代理关闭后删除证书包，不修改系统信任库。忽略这些变量、固定证书或强制 HTTP/2 的客户端可能无法使用；不要关闭证书验证。证书有效期为 24 小时，长期运行的进程需要重启以获得新代理。

限制模式要求域名列表，不能与本地回环直连例外或结构化 egress 混用；审批、子 agent 和恢复不会放宽这些限制。Windows 需要 PSEC 的自定义读取权限来访问公开证书包，旧账户后端会拒绝启动；这条路径已由平台测试在 PSEC 主机的真实沙箱 Shell 中验证：证书包获得可读范围授权，GET 在受限信任下成功，POST 返回 403，lease 关闭后证书包被删除。方法限制作用于托管进程代理，不覆盖宿主侧的 `web_fetch` 或远程 HTTP MCP；尚未实现可配置的 MITM 请求改写钩子。

<a id="supported-traffic"></a>

## 逐次网络审批与阻断原因

在托管配置中，用 `approval_domains` 指定需要逐次确认的域名，例如：

```toml
[execution_policy]
allowed_network_domains = ["api.github.com", "*.example.com"]

[execution_policy.network_proxy]
mode = "limited"
approval_domains = ["*.example.com"]
```

修改配置后重启一次即可。此例中 `api.github.com` 自动放行，`api.example.com` 每次访问都需确认。
`approval_domains` 是允许范围内的额外限制，不会突破 `allowed_network_domains`。两者都支持精确域名
和 `*.` 子域名规则；不配置或配置为空数组时，保留原来的自动放行行为。白名单外的域名、内网或保留
地址、离线策略及受限模式禁止的方法，不能靠普通审批放行，Full Access 也一样。

TUI 会用中英文显示目标域名、端口、协议、可见的 HTTP 方法，以及“仅允许本次”和“拒绝”。
请求在连接目标之前等待，允许后继续原请求，不重跑整条 Shell 命令，也不修改配置或重启进程。
普通 HTTP 和受限模式 HTTPS 每次只授权一条 HTTP 请求；完整模式 CONNECT / SOCKS 授权一条 TCP
隧道，隧道内可能有多条应用请求，完整模式无法看见加密的 HTTP 方法。新连接和重定向目标仍需重新检查，
没有“本会话允许”或永久授权。

Shell 返回后台句柄后审批仍有效。等待授权最多两分钟，期间暂停代理的连接准备与空闲计时；命令自身
的总超时和客户端超时仍然生效。进程退出、停止、请求断开、执行中断或界面关闭会取消等待；切换会话
会撤销旧进程的审批通道。旧审批不能在重启后恢复。

多客户端后台服务中，控制端断开就会取消网络审批，即使还有只读观察端在线；没有控制端时，新的
待审批网络请求直接拒绝。重连后可以审批新请求，但旧请求不会复活。普通命令审批和后台进程仍保留
原来的重连恢复行为。

阻断提示会区分域名不允许、HTTP 方法被禁止、内网地址、端口、DNS 失败、用户拒绝、无法交互审批、
审批超时或连接失败。提示只包含必要目标信息，不含 URL 路径、查询参数、凭证、请求正文或解析出的
内网 IP。每个进程最多显示 32 条；目前是实时界面提示，不保存为历史对话。

实时审批目前接入 Shell / Bash，包括子 agent。无交互执行和 stdio MCP 没有网络审批通道，访问
需要授权的域名会直接拒绝。宿主侧 `web_fetch` 同样没有审批通道，因此访问 `approval_domains`
中的目标会以 `network_approval_unavailable` 失败，而不是静默绕过已配置的网关；这类目标请改用
沙箱内 Shell 请求。远程 HTTP MCP、hooks 和插件联网仍不在此功能范围内，继续沿用原有域名白名单行为。
Windows 共用这些 TypeScript 代码，并已由平台测试在真实沙箱 Shell 中验证：请求在 yield 后继续等待一次审批，停止 Shell 会取消待定决策且不会触达源站。

## 支持的流量

| 环境 | 受域名限制的 Shell 行为 |
| --- | --- |
| 带 Seatbelt 的 macOS | 80 端口 HTTP，以及通过 CONNECT 访问 443 端口的 HTTPS |
| Windows 受限令牌沙箱 | 80 端口 HTTP，以及通过 CONNECT 访问 443 端口的 HTTPS；每个登录身份只允许连接自己的代理端口 |
| Windows PSEC | 相同的代理流量；本地服务例外见下文 |
| Linux | 网络启用且列表非空时，在启动进程前返回 `network_proxy_unavailable` |
| 网络禁用 / 域名列表为空 | 命令以离线模式运行 |

支持代理的客户端（例如 curl 和使用 HTTPS 的 Git）使用运行时提供的 `HTTP_PROXY`、`HTTPS_PROXY` 及小写变量。不遵循代理设置的工具无法直接连接。没有额外配置时只支持 HTTP 80 和 CONNECT 443；启用 SOCKS5 后，full 模式支持上述 TCP 扩展。UDP、HTTP 升级、Expect 和私有/本地目的地址仍不支持。

返回运行中句柄的 Shell 命令会一直保有代理，直到进程结束。停止命令、超时或关闭 mycli 都会撤销连接。代理允许 64 个客户端连接，请求头上限为 16 KiB，空闲 30 秒后关闭连接；DNS 和建立连接的时限为 10 秒。

<a id="enforcement-limits"></a>

## 强制执行的边界

每个 HTTP 目标和 CONNECT authority 都必须匹配冻结的允许列表，而且解析结果只能是公网地址。真正的上游连接使用已经检查过的数字地址，防止第二次 DNS 查询改变目标。

full 模式下，HTTPS 保持端到端加密，代理不检查 TLS SNI、加密的 Host 或应用内容。limited 模式会执行上文描述的 HTTPS 检查。两种模式都无法阻止已允许的远程服务器转发流量到其他地方。Seatbelt 放行的是回环 TCP 端口，不是某个监听进程的身份；这个边界假定无沙箱宿主与运行时可信。

Windows 旧账户后端使用专门的代理账户，WFP 默认禁止其联网。每条命令只获得匹配其独立登录 SID 和指定 IPv4 回环 TCP 端口的例外权限，无法连接另一条命令的代理端口。宿主在恢复挂起的进程前安装该规则，进程结束后撤销；它不会覆盖其他 Windows 防火墙限制。旧后端的网络受限进程必须使用 Read Only 或 Workspace 文件系统策略；“不限文件系统但限制网络”的组合会被拒绝。

PSEC 为进程分别实施策略，支持“不限文件系统但限制网络”。代理模式默认仅放行本命令的代理端口。源码新增的 `loopback_ports = [5432, 6379]` 可与 `allowed_network_domains` 一起使用，只额外允许直连 `127.0.0.1` 和 `::1` 的这些 TCP 端口。显式列表覆盖旧的 `allow_local_binding` 全端口例外；空列表不额外放行，离线限制仍优先。这是本地服务直连授权，不会让域名代理接受私有地址。该新增功能需要新版 PSEC helper；当前打包二进制未替换，Windows 编译和实机隔离验证仍待完成。详见 [Windows 端口限制与兼容性](windows.md)。

<a id="mcp-networking"></a>

## MCP 网络

MCP 进程使用独立的启动策略：默认是具备文件系统访问和网络权限的普通宿主子进程，但受托管网络及可写根目录上限约束。临时 Shell 授权和轮次权限选择器不会重新配置已运行的 MCP 进程。在 `mcp_servers.toml` 中设置 `[servers.<id>.sandbox] network = "disabled"`，可让单个服务器离线；设置 `mode = "workspace-write"` / `mode = "read-only"` 可限制文件写入。显式限制由平台沙箱实施，无法实施时拒绝执行。工具审批与进程隔离相互独立。

受域名限制的 stdio MCP 使用同一个 macOS/Windows 代理实现和流量限制，每一代进程各有一个代理。取消或超时会废弃该代进程并关闭代理；后续显式调用会创建新一代。Linux 无法执行所请求的联网域名限制时，会在启动进程前失败。在 Windows 旧账户后端上为 stdio MCP 设置离线或域名限制时，也需明确选择受限的文件系统模式。

远程 HTTP MCP 在每次请求前检查允许的主机名及网络启用/禁用策略。它会拒绝重定向，而不是转发端点凭据或工具参数。与 stdio 代理不同，这个 HTTP 客户端允许已配置的回环端点和自定义端口，不继承 Shell 代理环境。这些 HTTP 主机名检查不提供 stdio 代理的公网地址固定保证。另见 [MCP 配置](node-extensions.md#mcp)。
