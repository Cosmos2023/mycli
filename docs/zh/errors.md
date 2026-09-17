<a id="errors-and-recovery"></a>

# 错误与恢复

[English](../errors.md) | **简体中文** | [中文目录](README.md)

mycli 在 TUI 中展示错误的具体原因。工具失败会显示在对应工具行，轮次失败只产生一条提示。某个 gateway 请求被拒绝，不会终止另一个正在运行的轮次。详情视图包含原因、来源和稳定的诊断标识。解释错误不会额外调用模型。

| 原因示例 | 含义 | 下一步 |
| --- | --- | --- |
| `capability.image_input_unsupported` | 当前模型无法接收对话中已有的图片 | 使用 `/model` 选择支持图片的模型 |
| `auth.credentials_missing` | Provider 没有可用凭据 | 配置该 provider 的凭据 |
| `auth.model_access_denied` | 账号无权使用这个模型 | 检查权限或更换模型 |
| `provider.quota_exceeded` | 账号配额已耗尽 | 检查 provider 的账单与额度 |
| `provider.rate_limited` | Provider 正在限制请求频率 | 按界面显示的有限重试等待时间处理 |
| `provider.output_limit` | 生成尚未完成就达到输出上限，推理 token 也计入其中 | 检查输出上限，或选择支持更少推理的模型 |
| `provider.empty_response` | Provider 已结束，但没有答案或工具调用 | 重试或切换模型 |
| `runtime.compaction_summary_too_long` | 旧版本的摘要大小拒绝原因，为重放旧会话而保留 | 当前本地压缩不再单独限制摘要大小 |
| `runtime.retry_exhausted` | 自动重试已经停止 | 查看保留的底层原因 |
| `policy.sandbox_initialization_failed` | Shell 沙箱无法启动 | 运行 `mycli doctor` 并检查平台是否准备就绪 |
| `gateway.admission_rejected` | 请求在执行前被拒绝 | 等待容量释放后重试 |
| `gateway.output_capacity_exceeded` | 已接受的执行超过传输输出容量 | 重新提交前检查 `/status` 和 `/ps` |
| `runtime.worker_exited` | 运行时 Worker 意外退出 | 检查执行状态并运行 `mycli doctor` |
| `storage.write_failed` | 无法保存会话状态或其可读投影 | 检查存储诊断及记录的操作阶段 |
| `tui.render_failed` | 本地终端界面失败 | 检查私有 TUI 日志并运行 `mycli doctor` |

执行结果未知意味着命令可能已经运行。mycli 不会仅根据错误的 `retryable` 字段自动重放整个轮次。已完成工具的效果和已接受的图片会保留在历史中。切换模型不会再次执行已完成的工具，也不会静默丢弃图片。

普通错误会显示在实时输出和重新加载的历史中。恢复建议会根据当前会话和模型刷新，因此即使模型兼容问题已经解决，历史图片错误仍可能可见。

致命 TUI/连接诊断写入 `~/.mycli/logs/tui-errors.log`，并使用私有文件权限。日志包含大小受限的错误上下文和脱敏堆栈。输出兜底 stderr 消息前会恢复终端；本地 UI 失败不会添加对话记录。运行时存储紧急错误还会使用现有的私有运行时跟踪日志。

<a id="compatibility"></a>

## 兼容性

版本 1 在 12 个领域中定义了 69 种具体原因。已有运行时记录保留原有的 17 个宽泛错误码。旧的 `unsupported_capability` 记录不能证明是图片不兼容，旧的 `interrupted` 记录也不能证明是用户取消。

当前运行时使用数据库格式 15（包含持久化会话目标）。打开格式 12、13 或 14 时，会在事务中升级格式，不重写对话事件。这项小型向前迁移沿用现有运行时存储的打开流程，不会自动创建备份。如果升级后可能需要回退程序，应先创建一致性备份。复制正在使用的 SQLite 数据库时，不能遗漏所需的 WAL 状态。

旧程序会在打开可写存储前拒绝较新的格式。回退程序需要匹配的升级前备份，或单独审查过的导出文件。修改版本标记或删除错误元数据都不是受支持的降级方式。对话快照 v2 仍然可读，因为扩展使用的是现有的可选元数据字段。

Gateway 协议 1 在引导阶段协商增强错误信息；旧客户端收到旧格式的封装。Worker 协议 2 要求运行时模块版本匹配。遇到未知的可选错误扩展时，系统回退到宽泛错误，不会编造原因或重试操作。
