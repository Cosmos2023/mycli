<a id="changelog"></a>

# 更新日志

[English](../../CHANGELOG.md) | **简体中文** | [中文目录](README.md)

本文件记录 mycli 的重要变化。版本只由统一发布流程分配。

<a id="unreleased"></a>

## 未发布

<a id="added"></a>

### 新增

- 对齐 Codex 的配置来源追踪、首次设置、权限、诊断、会话恢复、终端无障碍、补全和非 TTY 契约。
- 显式配置迁移预览、应用、备份和回退命令。
- 跨 macOS、Ubuntu、Windows 的无需 provider 的打包产物及依赖注册表的发布兼容性验证。

<a id="changed"></a>

### 变更

- 当前维护的公开应用包名为 `@cosmos2023/mycli`。
- 平台 ripgrep 包使用 `@cosmos2023` scope，仍是按目标平台选择的可选依赖。
- 本条发布记录的可写会话使用仅支持新建的 schema 12。Schema 9 旧会话不原地转换，需要完整数据库附属文件和兼容旧程序。

<a id="deprecated"></a>

### 弃用

- 弃用 `@cosmos2023/app`，改用 `@cosmos2023/mycli`。尚未安排移除，见 `docs/upgrading.md#package-name-migration`。

## 0.1.0 - 2026-08-27

<a id="added-1"></a>

### 新增

- 首次公开发布 Node.js/TypeScript mycli 和各平台 ripgrep 包。
