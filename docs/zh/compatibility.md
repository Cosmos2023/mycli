<a id="compatibility-policy"></a>

# 兼容性策略

[English](../compatibility.md) | **简体中文** | [中文目录](README.md)

发布兼容性的机器可读依据是 [`release/compatibility-policy.json`](../../release/compatibility-policy.json)。运行 `npm run release:compatibility` 可检查策略、包清单、运行时 schema 常量、启动耗时预算与这些文档是否一致。

<a id="supported-runtime"></a>

## 支持的运行环境

| 范围 | 支持约定 |
| --- | --- |
| Node.js | 22.19.0 或更新版本；发布 CI 测试 22.19.0 和 Node 24 |
| 操作系统 | 当前 macOS、Ubuntu 和 Windows 发布 runner |
| 公开 CLI 包 | `@cosmos2023/mycli`；可执行命令为 `mycli` |
| 模型目录 | 优先按 provider 分组；仍可读取旧式扁平目录 |
| 配置迁移 | 契约版本 1，包含显式预览、应用、备份和回退 |

六个公开 ripgrep 包按操作系统和 CPU 架构选择。打包发布检查验证全部六个产物，安装后的冒烟测试只使用当前宿主对应的包。缺少原生沙箱支持时会拒绝执行，不会回退到无限制模式。

<a id="configuration-window"></a>

## 配置兼容范围

标准用户配置文件是 `~/.mycli/config.toml`。旧路径 `~/.config/mycli/config.toml` 仍可读取，并可以显式迁移：

```bash
mycli config migrate --dry-run
mycli config migrate --apply --expected-version <version>
mycli config migrate --rollback <backup-id>
```

普通启动不会运行迁移。应用迁移前会先创建私有备份，再修改标准配置文件。回退需要备份 ID，并恢复迁移前的路径。Provider 凭据不参与 TOML 迁移，仍保存在 `~/.mycli/auth.json` 或环境变量中。

当前维护的目录格式是按 provider 分组的 `models.json`。旧式扁平目录仍然可用，因此升级不要求立即重写。对于按 provider 分组的版本 2，基于内置目录的 `models` 条目表示覆盖或明确新增；除非声明 `model_policy: "subset"`，否则路由会跟随固定版本 pi-ai 目录中的新模型。旧式扁平目录保留显式子集行为。

<a id="session-window"></a>

## 会话兼容范围

本兼容性策略记录的运行时会话 schema 为 `12`。正常启动和恢复只直接读取 schema `12`。无需 provider 的会话维护路径可以检查 schema `9`、`10`、`11` 和 `12`，并提供以下显式向前迁移：

| 起始版本 | 目标版本 | 维护操作 |
| ---: | ---: | --- |
| 9 | 10 | `/session maintenance --apply-transcript-normalization` |
| 10 | 11 | `/session maintenance --apply-content-blobs` |

支持检查旧 schema 不等于能够直接恢复旧会话。降级安装包或执行维护迁移前，请备份 `~/.mycli`。只有目标版本使用相同会话 schema 时才支持降级；mycli 不会为旧版本静默重写会话。

<a id="deprecations"></a>

## 弃用项目

稳定的弃用记录在策略文件中包含引入、弃用、移除、替代和迁移字段。

| ID | 对象 | 引入版本 | 弃用版本 | 移除安排 | 替代项 |
| --- | --- | --- | --- | --- | --- |
| `npm-package-cosmos2023-app` | `@cosmos2023/app` | 0.1.0 | 0.1.0 | 尚未安排 | `@cosmos2023/mycli` |

保留旧包只是为了使用真实发布过的前身进行兼容性测试。新安装必须使用 `@cosmos2023/mycli`。替换步骤见 [upgrading.md](upgrading.md#package-name-migration)。

<a id="release-evidence"></a>

## 发布验证证据

`.github/workflows/release-compatibility.yml` 在 macOS、Ubuntu 和 Windows 上运行打包后的候选版本，验证配置迁移与回退、会话恢复、更新不阻塞行为、沙箱就绪状态、补全、无颜色输出和非 TTY 管理命令。另一个依赖包注册表的流程会安装真实旧版本、升级到候选版本、降级并回退迁移。每个平台的产物都包含一份打包流程摘要和一份升级/降级摘要。

注册表或网络不可用会记录为 `blocked_external`，并附上受限的阶段信息和错误码，不能报告为产品验证通过。候选版本自身失败一定会让门禁失败。标签发布流程会在 npm 发布前严格执行相同检查。

启动证据使用仓库中的 `tests/fixtures/configuration_ux/baseline.json`。首次绘制前不得等待更新、doctor 或迁移的网络操作；打包后的原生 PTY 就绪时间上限为 5000 ms。证据只包含结构性状态，不包含凭据、提示词、provider 请求体、命令输出或本地绝对路径。

全部八项路线图结果的对应关系见 [parity/configuration-ux-release-evidence.md](../parity/configuration-ux-release-evidence.md)。
