# mycli 中文文档

[English](../README.md) | **简体中文**

安装、快速开始和功能概览请先阅读[中文 README](../../README_zh.md)。本目录收录现行使用指南、配置参考和开发文档的中文译本，每篇都提供英文原文链接。

## 使用指南

| 文档 | 内容 |
| --- | --- |
| [命令参考](commands.md) | CLI、slash 命令、无界面执行、补全、设置和操作反馈 |
| [Provider](providers.md) | 内置路由、Qwen、额外模型目录、自定义端点、凭据和重试 |
| [配置参考](reference/configuration.md) | 配置键、类型、默认值、可写范围和兼容别名 |
| [带中文注释的配置示例](reference/config.example.toml) | 可参考的 TOML 设置，所有配置项默认注释 |
| [终端与无障碍](terminal-accessibility.md) | 外观、快捷键、CJK/IME、粘贴、审批和终端交互 |
| [会话](sessions.md) | 查找、恢复、修复、分叉、存储和完整对话 JSONL 导出 |
| [目标](goals.md) | `/goal`、自动继续、token 预算、审批边界和恢复 |
| [扩展](node-extensions.md) | Skills、MCP、OAuth、服务器提问、hooks 和工具发现 |
| [插件安装与兼容性](plugin-codex-parity.md) | 安装、市场、包格式、启用、更新和 Codex 兼容范围 |
| [网络策略](network-policy.md) | Shell/MCP 网络权限、域名限制和平台支持 |
| [Windows](windows.md) | 源码安装、Shell 选择、PTY 和沙箱配置 |
| [诊断与更新](diagnostics-and-updates.md) | Doctor、修复预览、诊断包、更新缓存和通知 |
| [故障排查](troubleshooting.md) | 启动、provider、沙箱、会话、扩展和升级问题 |
| [错误与恢复](errors.md) | 错误原因、TUI 展示、重试和存储兼容性 |
| [升级与回退](upgrading.md) | 包名迁移、备份、配置迁移和版本回退 |

## 开发参考

| 文档 | 内容 |
| --- | --- |
| [总体架构](architecture.md) | 包职责、运行时、持久化、模型输入和工具边界 |
| [配置信任与来源](architecture/configuration-trust-and-provenance.md) | 配置优先级、工作区信任、凭据和迁移边界 |
| [Gateway API](gateway.md) | Stdio app-server、嵌入客户端、契约、背压和生命周期 |
| [Agent 运行时](node-agent-runtime.md) | 线程、Worker、协作、权限、内存、产物和恢复 |
| [TUI 架构](tui.md) | 模块分层、状态到渲染、输入区、粘贴和操作反馈 |
| [Plugin API v2](plugin-api-v2.md) | 编译 ESM、清单、注册、隔离进程协议和诊断 |
| [Python 插件迁移](migration/python-plugins-to-v2.md) | 旧插件到 Plugin API v2 的对应关系、步骤和验证 |
| [测试](testing.md) | 测试分类、命令、CI 和测试维护 |
| [编程评估](coding-evaluation.md) | 固定任务集、模型实测与系统提示词行为评估 |
| [兼容性策略](compatibility.md) | 发布兼容范围、弃用政策和验证证据 |
| [发布流程](releasing.md) | 统一版本、打包、发布门禁和部分发布恢复 |
| [Node 运行时推广](node-runtime-rollout.md) | M8 迁移背景、发布验收和包级回退 |
| [候选版本说明](release-notes.md) | 原文记录的候选发布变化及操作说明 |
| [更新日志](CHANGELOG.md) | 已记录的版本变化 |

## 上下文设计与历史资料

下列原有上下文参考正文已包含中文，可直接阅读：

- [上下文组装参考](../context/mycli-context-assembly-reference.md)
- [前缀缓存与请求结构](../context/prefix-cache-request-shape-design.md)
- [P5–P8 后的上下文实例](../context/context-assembly-after-p5-p8-reference.md)
- [上下文组装路线图](../context/prefix-cache-context-assembly-roadmap.md)
- [历史目标文本](../context/prefix-cache-context-assembly-goals.md)

历史对照报告、发布验证证据和实施计划保留在原目录，入口见[原文文档索引](../README.md)和 [Superpowers 历史资料](../superpowers/)。

## 同步约定

译文保留命令、配置键、协议字段、模型 ID 和代码示例。章节保留原文锚点，中文文档之间优先互相链接；每篇顶部可切回英文原文。

更新英文文档后，请同步对应译文。配置键和默认值以自动生成的[英文参考](../reference/configuration.md)为依据；重新生成后再同步中文说明与示例注释。原文中的历史版本、实测日期和验收数字保留原适用范围，不代表本次翻译重新执行了那些验证。
