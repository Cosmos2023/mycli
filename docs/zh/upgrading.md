<a id="upgrading-and-rolling-back"></a>

# 升级与回退

[English](../upgrading.md) | **简体中文** | [中文目录](README.md)

更换已安装的 mycli 版本前，先执行不依赖 provider 的备份与验证流程。npm 版本不可变，应选择明确的已发布版本，不要依赖被替换的同版本产物。

<a id="package-name-migration"></a>

## 包名迁移

`@cosmos2023/app` 已弃用，当前维护的包是 `@cosmos2023/mycli`。两者都提供名为 `mycli` 的可执行命令。

```bash
npm uninstall -g @cosmos2023/app
npm install -g @cosmos2023/mycli
mycli --version
mycli doctor
```

不要将两个包安装到同一个全局前缀目录。它们占用相同的可执行命令，最后安装的包会让实际运行的版本难以判断。

包名迁移不会转换会话数据库。已发布的前身 `@cosmos2023/app@0.1.0` 创建 schema 9；本文对应的候选版本仅在全新的 schema 12 数据库上启动可写会话，没有 schema 9 到 12 的原地升级路径。请将旧的 `sessions.db`、`sessions.db-wal` 和 `sessions.db-shm` 完整保存在一起，并使用兼容的旧程序打开这些会话。停止所有 mycli 进程后，将整套文件移动到备份位置，再让新包启动一个全新的会话数据库。

<a id="before-an-upgrade"></a>

## 升级前

1. 完成或中断当前轮次，停止后台 Shell。
2. 退出所有正在使用该会话的 mycli 进程。
3. 备份整个 `~/.mycli` 目录，包括 `sessions.db` 和配置备份。
4. 运行 `mycli doctor --json`，只保留大小受限的状态信息，不保留本地配置或密钥。
5. 阅读 [compatibility.md](compatibility.md)，确认目标版本的 Node、配置和会话兼容范围。

安装选定版本后，验证已安装产物：

```bash
npm install -g @cosmos2023/mycli@<version>
mycli --version
mycli config validate --strict
mycli doctor
mycli sandbox status
```

<a id="configuration-migration"></a>

## 配置迁移

迁移需要显式执行，并采用乐观并发检查。先预览操作，记录返回的 `expectedVersion`，期间不要编辑源文件：

```bash
mycli config migrate --dry-run --json
mycli config migrate --apply --expected-version <expected-version> --json
```

应用操作会返回私有 `backupId`。请保留它，直到确认升级后的 CLI 和配置正常。如果预览后源文件发生变化，应用操作会因版本冲突而停止，不会执行一项不同的迁移。

要准确恢复迁移前的路径：

```bash
mycli config migrate --rollback <backup-id> --json
```

回退在本地显式执行，不会降级 npm 包、会话数据库或模型目录。凭据永远不会被复制到迁移输出中。

<a id="package-rollback"></a>

## 安装包回退

安装旧版本前，确认它直接支持当前会话 schema。当前策略只允许相同 schema 之间降级。维护命令能检查某个旧 schema，并不证明正常恢复流程支持它。

```bash
npm install -g @cosmos2023/mycli@<previous-version>
mycli --version
mycli doctor
```

如果文档中的 0.1.0 前身验证流程需要旧包名，请先移除当前维护的包：

```bash
npm uninstall -g @cosmos2023/mycli
npm install -g @cosmos2023/app@0.1.0
```

Doctor 报告 schema 不匹配时，不要打开会话。请重新安装兼容的候选版本，或在所有 mycli 进程停止后恢复备份的 `~/.mycli` 目录。不要只复制 `sessions.db` 而遗漏相关配置与状态文件。

<a id="recovery"></a>

## 恢复

- npm 安装失败不意味着可以删除 `~/.mycli`。
- 配置应用失败后，必须重新预览才能再次尝试。
- 无法从发布验证证据重建缺失的迁移备份。
- 应先解决注册表、认证或网络故障再重试；这些故障不能证明某个包版本不存在。
- Windows 沙箱安装属于机器状态。回退安装包后，应运行 `mycli sandbox status` 并按 [windows.md](windows.md) 操作，而不是绕过辅助程序。
