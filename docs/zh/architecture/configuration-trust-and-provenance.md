<a id="configuration-trust-and-provenance"></a>

# 配置信任与来源追踪

[English](../../architecture/configuration-trust-and-provenance.md) | **简体中文** | [中文目录](../README.md)

状态：已纳入 v0.2 配置基础与诊断设计。

<a id="context"></a>

## 背景

mycli 读取系统、用户、profile、项目、旧版、环境变量和会话/CLI 配置。过去 Node 后端在加载工作区信任前就解析项目 `.mycli/config.toml`，用户配置静默优先于项目配置，解析器也不保留所选键的来源。仓库 hooks、MCP 服务器、插件、skills 和执行规则的发现没有共用一项信任决定。

这使启动行为难以解释，也让项目控制的内容在用户信任规范工作区之前进入配置和集成边界。

<a id="decision"></a>

## 决策

配置优先级从高到低为：

1. 会话与 CLI 覆盖。
2. 环境变量。
3. 受信任项目配置。
4. 启动时选定的 `~/.mycli/<name>.config.toml` profile。
5. 用户配置 `~/.mycli/config.toml`。
6. Unix 的 `/etc/mycli/config.toml` 或 Windows 的 `%ProgramData%\mycli\config.toml` 系统配置。
7. 旧用户配置 `~/.config/mycli/config.toml`。
8. 内置及 provider 默认值。

初始配置层栈契约版本为 `1`。每层记录稳定 ID、范围、来源、版本、启用状态、禁用原因和声明的键。每键来源记录获胜层及被覆盖的低优先级层，不包含配置值、凭据、请求头或 provider 数据。

`WorkspaceTrustStore` 是项目准入的权威来源。运行时和默认管理组装在读取项目配置或发现仓库集成前加载规范工作区的信任决定。`unknown` 或 `untrusted` 工作区生成原因是 `workspace_not_trusted` 的禁用项目层，不打开或解析项目 TOML。同一门禁排除：

- 仓库 hooks。
- 仓库 MCP 服务器。
- 仓库插件及项目插件启用配置。
- 仓库 `.agents/skills` 与 `.mycli/skills`。
- 项目执行规则。

恢复会话时，持久化会话工作区决定信任和集成发现范围，而非进程启动目录。

<a id="scope-semantics"></a>

## 范围语义

会话/CLI 覆盖影响活动运行时，优先于持久文件。环境变量影响当前进程。用户配置是跨工作区的持久默认值；项目配置只对受信任工作区持久有效。普通 `/model` 选择默认属于会话，只保存活动会话偏好；明确选择 `Make user default` 后，先通过类型化用户配置写入器保存，再应用同一偏好到活动会话。

`--profile <name>` 和 `-p <name>` 是外部加载器输入，不是配置键。构造路径前，名称必须满足跨平台 `[A-Za-z0-9_-]+` 语法。始终加载基础用户文件，再在其上加载选定稀疏 profile；缺失 profile 是已启用的空层。选择只作用于进程，不写入用户文件或会话偏好。系统层对普通 mycli 命令始终只读；无法解析 Windows ProgramData 目录时使用 `C:\ProgramData`。

<a id="secret-boundary"></a>

## 秘密信息边界

API Key 和 token 应存于 `~/.mycli/auth.json` 或进程环境。项目、所选 profile 和系统配置不能包含凭据。来源追踪和诊断可以暴露键名和来源分类，不能暴露原值。已有 `resolveConfig` 返回值仍是内部运行时对象，不能直接序列化到 TUI 或日志。

<a id="diagnostic-boundary"></a>

## 诊断边界

配置包管理统一、带版本的诊断词汇。`resolveConfigWithMetadata` 返回不含配置值的警告，以及解析配置和层栈。致命读取、解析、凭据和已知值失败以相同诊断格式的 `ConfigError` 跨边界。运行时和管理调用方消费这份契约，不自行分类原始解析器/文件系统异常。

未知根键、表和已知表中的未知键均为警告，保留所属文件层与有界点分键路径，不改变有效运行行为。TOML 语法失败只保留解析器提供的数字行列。普通键没有保留源位置，因此 schema 发现不声称拥有源范围。

诊断可含稳定版本、代码、严重度、文件层 ID、有界键路径、数字源位置、公开消息和修复建议，不能包含原配置值、TOML 源码或代码块、异常堆栈、请求数据、凭据或绝对路径。`mycli doctor` 无需启动 provider 即可投影为有界条目。

项目凭据字段为致命错误。为兼容旧版，只有用户或旧用户文件根级 `api_key` 仍可读取，并发出迁移警告。所有文件层中的表内凭据字段（包括 `[model].api_key`）均被拒绝。环境凭据和 `~/.mycli/auth.json` 仍有效且无警告。

<a id="compatibility"></a>

## 兼容性

`resolveConfig` 继续作为旧调用方的兼容门面；需要来源元数据的调用方使用 `resolveConfigWithMetadata`。省略 `workspaceTrust` 会保留旧库行为，供兼容测试和受控适配器使用；交互运行时和默认管理调用方必须始终传入持久状态。

旧扁平键仍可读，并产生有界 `deprecated_key` 诊断。存在旧用户文件时产生 `deprecated_config_file`，读取不会重写它。Profile 和系统层是增量能力，没有这些文件的安装保留原有效值。仍不提供 profile 管理命令、持久活动 profile、profile 范围修改、自动迁移或伪造的 schema 源范围。

标准设置目录现在管理描述、值类型、标准路径、兼容别名、允许值、可变性和重启元数据。提交到仓库的 Markdown、JSON 和带注释 TOML 参考从该目录生成并检查一致性。`config validate --strict` 将任何遗留警告转为命令失败，不改变普通运行时解析。

<a id="migration-and-mutation-boundary"></a>

## 迁移与修改边界

`config path` 使用与运行时加载相同的平台辅助函数解析用户、项目、所选 profile、系统和旧用户路径，只处理元数据；配置管理只允许写基础用户范围。

迁移不会自动发生。`config migrate --dry-run` 根据精确用户与旧用户字节生成脱敏计划，返回复合 SHA-256 预期版本。应用时重新获取共享用户配置锁、重建计划、拒绝过期用户或旧用户版本、验证独立目标和完整有效栈、写入带时间戳的私有备份，再原子替换一次用户文件。旧文件不变，因为双文件重写无法保证原子性。

回退只接受有界备份 ID，验证备份完整性和当前已应用用户版本，再验证恢复候选并还原旧字节或原文件不存在状态。应用和回退都不访问 `auth.json`。预览和响应只暴露键、变化种类、稳定层 ID、哈希和截断状态，不含配置值、TOML 源码、凭据内容或备份数据。

<a id="operational-consequences"></a>

## 运行影响

运行时空闲时变更信任，会事务性重载仓库集成和模型/运行配置。授予信任先保存决定再打开项目文件；项目配置或集成启动失败时，保存决定与活动运行时一起恢复。撤销信任先切到仅用户配置、工具、hooks、命令、资源和扩展宿主，再保存不信任决定。会话级模型/推理选择仍优先于新准入的项目默认值。

今后的配置编辑器、doctor、首次设置和迁移命令都必须从标准层栈获取有效值和解释。修改设置描述后，必须重新生成参考产物并通过 `npm run config:check`。
