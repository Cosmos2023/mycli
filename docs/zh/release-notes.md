<a id="release-candidate-notes"></a>

# 候选版本说明

[English](../release-notes.md) | **简体中文** | [中文目录](README.md)

这些说明描述当前源码候选版本。发布人员执行统一版本和标签流程时，会将标题替换为选定版本。本文档本身不会分配或发布版本。

<a id="configuration-and-onboarding"></a>

## 配置与首次设置

- 新增确定性的配置优先级、来源追踪、项目受信任检查、启动配置、严格验证、自动生成的参考文档，以及显式迁移预览、应用和回退。
- 统一首次运行时的 provider、凭据、模型、信任和权限设置，同时保留取消和离线配置能力。
- 新增不依赖 provider 的登录状态/退出登录、setup、config、doctor、session、update、sandbox、hook、plugin 和 MCP 管理命令，用于自动化。
- 新增直接支持的 OpenRouter、Groq、Together、Moonshot AI、NVIDIA 和 Cerebras 配置，基于固定版本的 pi-ai 传输，对未知模型采取保守处理，并使用与模型兼容的设置默认值。

<a id="runtime-and-terminal"></a>

## 运行时与终端

- 恢复会话时保留会话级模型和推理选择，不重写用户默认配置。
- 新增显式权限切换、平台沙箱就绪检查与恢复、信息受限且可操作的错误，以及脱敏诊断包。
- 新增可配置终端快捷键、语义颜色模式、减少动态效果、ASCII 回退、bash/zsh/fish/PowerShell 补全、适配 CJK/IME 的布局，以及明确的非 TTY 行为。

<a id="packaging-and-compatibility"></a>

## 打包与兼容性

- 公开包为 `@cosmos2023/mycli`；`@cosmos2023/app` 是已弃用的已发布前身，用于升级/降级门禁。
- 六个 `@cosmos2023/ripgrep-*` 包提供各目标平台的 ripgrep 二进制；九个私有工作区继续随应用 tarball 一起分发。
- 本候选版本说明中的会话 schema 12 仅支持新建。由 schema 9 前身创建的会话不会原地转换，必须与完整数据库附属文件和兼容的旧程序一起保留。
- 打包产物测试现在覆盖补全、无颜色输出、管理命令、迁移与回退、会话恢复、不阻塞的更新操作、原生 PTY 启动和平台选择。
- 独立可见的 macOS、Ubuntu 和 Windows 流程记录脱敏的兼容性证据。产品失败仍视为失败，外部注册表故障会明确标记。

<a id="operator-notes"></a>

## 发布操作说明

- npm 上已经存在 `@cosmos2023/mycli@0.1.0`。发布本候选版本前，运行 `npm run release:version -- <new-semver>`。
- 创建标签前，阅读 [compatibility.md](compatibility.md)、[upgrading.md](upgrading.md) 和 [releasing.md](releasing.md)。
- 此次没有新增遥测、自动执行包管理器、静默更新，或自动配置/会话迁移。
