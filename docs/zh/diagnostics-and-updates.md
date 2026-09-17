<a id="diagnostics-and-updates"></a>

# 诊断与更新

[English](../diagnostics-and-updates.md) | **简体中文** | [中文目录](README.md)

mycli 提供一套不依赖 provider 的健康报告，以及保守的缓存更新流程。两者都不会将提示词、工具内容、凭据或原始 provider 响应发送到支持服务。

<a id="diagnostics"></a>

## 诊断

先运行简洁的本地报告：

```bash
mycli doctor
mycli doctor --verbose
mycli doctor --json
mycli doctor --fix --json
mycli doctor --support-bundle --json
```

默认报告检查权威本地配置、凭据就绪状态、沙箱与终端支持、会话存储和所有权、扩展，以及缓存的更新状态，不调用模型 provider。一个采集器失败只产生一条大小受限的诊断，不会阻止其余采集器运行。

MCP 和插件检查只读取配置与清单，不启动服务器或插件宿主。详情中的 `runtime=not_probed` 表示元数据检查通过，不代表真实连接成功。修复预览和诊断包也是如此。要主动连接一个 MCP 服务器、发现能力并结束探测，可运行 `mycli mcp inspect <server-id>`。

每一项都有稳定的分类和代码、简短摘要、可选且大小受限的详情、修复建议、恢复操作，以及采集耗时。`--verbose` 在人类可读报告中显示详情；`--json` 输出相同的结构化条目，并附带大小受限的支持清单，只包含运行时版本、平台标识、诊断代码和安全日志引用。

诊断输出不包含 API Key、环境变量值、提示词、命令、工具内容、原始 provider 请求体、内部堆栈或不必要的绝对路径。应分享稳定的分类、代码和修复建议，不要复制私有配置或会话文件。

`mycli doctor --fix` 是只读修复预览，返回绑定于所列操作、不含配置值的变更说明和权威来源版本的计划 ID。使用以下命令应用该计划：

```bash
mycli doctor --fix --confirm <plan-id>
```

应用前 mycli 会重建计划。来源变化时返回 `version_conflict`，不会静默应用替代计划。各项修复独立报告，复用其所属服务，仍然不调用 provider、不安装包、不提升权限，也不执行任意 Shell 脚本。

`mycli doctor --support-bundle` 通过私有、原子替换写入 `~/.mycli/support/diagnostic-support.json`。确定性 schema 包含允许列表中的诊断条目、配置层元数据、Sandbox/会话/扩展就绪状态、运行时版本和相对日志引用。它不会复制日志、对话、提示词、命令、工具内容、provider 请求体、凭据、请求头、内部堆栈或不必要的本地路径，也不会自动上传。

<a id="cached-update-checks"></a>

## 缓存更新检查

启动时只读取一次 `~/.mycli/version.json`，随后立即使用缓存状态继续。缓存不存在或超过 20 小时时，会在后台启动限时五秒的 npm 注册表刷新。刷新不会延迟运行时就绪或 TUI 首次绘制。后台获取的版本最早在下一次启动时提示。

只会提示 `@cosmos2023/mycli` 的严格稳定语义版本。离线、超时、响应格式错误、缓存损坏和缓存写入失败都不是致命错误，并会保留上一次有效缓存。缓存具有私有权限、版本标识、大小限制和锁，并通过原子替换更新。

无需启动 Agent 即可检查或刷新更新状态：

```bash
mycli update
mycli update status
mycli update check
mycli update --json
```

TUI 内的 `/update` 显示缓存状态和安装指引；只有 `/update check` 会明确联系注册表。已知安装方式时，mycli 提供 npm、pnpm、Yarn 或 Bun 命令；否则将 npm 命令标为手动回退方式。它不会启动包管理器或请求提升权限。

使用以下任一命令忽略当前提示的版本：

```bash
mycli update dismiss 0.2.0
/update dismiss 0.2.0
```

忽略版本 X 只抑制 X，后续版本 Y 仍可在未来启动时提示。

通过标准用户配置关闭所有自动启动刷新和通知：

```bash
mycli config set updates.check_on_startup false
mycli config get updates.check_on_startup
```

显式执行 `mycli update check` 或 `/update check` 仍会按用户要求检查注册表。使用 `mycli config set updates.check_on_startup true` 可重新启用自动检查。
