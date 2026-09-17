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

<a id="supported-traffic"></a>

## 支持的流量

| 环境 | 受域名限制的 Shell 行为 |
| --- | --- |
| 带 Seatbelt 的 macOS | 80 端口 HTTP，以及通过 CONNECT 访问 443 端口的 HTTPS |
| Windows 受限令牌沙箱 | 80 端口 HTTP，以及通过 CONNECT 访问 443 端口的 HTTPS；每个登录身份只允许连接自己的代理端口 |
| Linux | 网络启用且列表非空时，在启动进程前返回 `network_proxy_unavailable` |
| 网络禁用 / 域名列表为空 | 命令以离线模式运行 |

支持代理的客户端（例如 curl 和使用 HTTPS 的 Git）使用运行时提供的 `HTTP_PROXY`、`HTTPS_PROXY` 及小写变量。不遵循代理设置的工具无法直接连接。此代理不支持 SSH、UDP、自定义端口、HTTP 升级、Expect 或私有/本地目的地址，也不要求关闭证书验证或安装 mycli 证书。

返回运行中句柄的 Shell 命令会一直保有代理，直到进程结束。停止命令、超时或关闭 mycli 都会撤销连接。代理允许 64 个客户端连接，请求头上限为 16 KiB，空闲 30 秒后关闭连接；DNS 和建立连接的时限为 10 秒。

<a id="enforcement-limits"></a>

## 强制执行的边界

每个 HTTP 目标和 CONNECT authority 都必须匹配冻结的允许列表，而且解析结果只能是公网地址。真正的上游连接使用已经检查过的数字地址，防止第二次 DNS 查询改变目标。

HTTPS 保持端到端加密。代理不检查 TLS SNI、加密的 Host 请求头或应用内容，也无法阻止已允许的远程服务器转发流量到其他地方。因此域名过滤控制的是目的地址选择，而不是内容。Seatbelt 放行的是回环 TCP 端口，不是某个监听进程的身份；这个边界假定无沙箱宿主与运行时可信。

Windows 使用专门的代理账户，WFP 默认禁止其联网。每条命令只获得匹配其独立登录 SID 和指定 IPv4 回环 TCP 端口的例外权限，无法连接另一条命令的代理端口。宿主在恢复挂起的进程前安装该规则，进程结束后撤销；它不会覆盖其他 Windows 防火墙限制。Windows 的网络受限进程必须使用 Read Only 或 Workspace 文件系统策略；“不限文件系统但限制网络”的组合会被拒绝。

<a id="mcp-networking"></a>

## MCP 网络

MCP 进程使用独立的启动策略：默认是具备文件系统访问和网络权限的普通宿主子进程，但受托管网络及可写根目录上限约束。临时 Shell 授权和轮次权限选择器不会重新配置已运行的 MCP 进程。在 `mcp_servers.toml` 中设置 `[servers.<id>.sandbox] network = "disabled"`，可让单个服务器离线；设置 `mode = "workspace-write"` / `mode = "read-only"` 可限制文件写入。显式限制由平台沙箱实施，无法实施时拒绝执行。工具审批与进程隔离相互独立。

受域名限制的 stdio MCP 使用同一个 macOS/Windows 代理实现和流量限制，每一代进程各有一个代理。取消或超时会废弃该代进程并关闭代理；后续显式调用会创建新一代。Linux 无法执行所请求的联网域名限制时，会在启动进程前失败。在 Windows 上为 stdio MCP 设置离线或域名限制时，也需明确选择受限的文件系统模式。

远程 HTTP MCP 在每次请求前检查允许的主机名及网络启用/禁用策略。它会拒绝重定向，而不是转发端点凭据或工具参数。与 stdio 代理不同，这个 HTTP 客户端允许已配置的回环端点和自定义端口，不继承 Shell 代理环境。这些 HTTP 主机名检查不提供 stdio 代理的公网地址固定保证。另见 [MCP 配置](node-extensions.md#mcp)。
