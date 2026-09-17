<a id="session-discovery-and-recovery"></a>

# 会话查找与恢复

[English](../sessions.md) | **简体中文** | [中文目录](README.md)

mycli 将权威会话状态保存在 `~/.mycli/sessions.db`。交互式 TUI 与无需 provider 的 `mycli session` 命令使用相同的后端会话服务、排序、过滤、元数据和所有权规则。列出或预览会话不会发起 provider 请求。

<a id="discover-sessions"></a>

## 查找会话

TUI 的 `/resume` 会打开可搜索会话选择器。每行优先显示会话标题或 ID、最近活动、模型与推理强度、协作模式、权限配置、生命周期状态、所有者锁、分叉关系和工作目录。

对应的无需 provider 的命令：

```bash
mycli session list
mycli session list --last
mycli session list --all
mycli session list --workspace /path/to/project
mycli session list --search release --model gpt-5.6-sol
mycli session list --mode plan --permission full-access
mycli session list --status interrupted --limit 50
mycli session list --json
```

结果按最近活动排序，再按稳定会话 ID 排序。默认隐藏归档和已删除会话；`--all` 包含两者。支持的状态过滤为 `active`、`archived`、`deleted`、`waiting_approval`、`waiting_clarification` 和 `interrupted`。

<a id="resume-and-repair"></a>

## 恢复与修复

通过已知会话启动交互界面：

```bash
mycli session resume <session-id>
```

现有 TUI 中的 `/resume <session-id>` 执行相同切换。切换前，mycli 根据保存的工作区、模型、凭据引用、权限配置、元数据版本、待处理状态和所有者租约，生成无需 provider、不会修改数据的修复预览。

会话就绪时立即恢复。存在可恢复阻塞时，打开仅使用键盘的选择器：

- `unarchive`：先取消归档，再恢复。
- `fork_with_current_settings`：使用当前工作区、模型、凭据引用和权限配置创建子会话，不改变源对话和偏好。
- `takeover_stale_owner`：确认替换已退出进程的租约；协调器获取会话时原子完成替换。

无法替换仍活动的所有者。缺失或不兼容的会话状态如果没有安全修复方式，会保持阻塞并给出一条可操作诊断。在修复选择器按 Esc 可取消，不改变源会话。

在新运行时中激活已保存会话，会中断未完成轮次并清除旧审批和提问等待。已提交的工具结果保留，工具不会重新执行，后台进程句柄无法恢复。TUI 从权威对话事件重建历史，每条中断提示只显示一次。重新连接仍在运行的后端会保留该后端有效的请求和进程，不执行冷恢复。

同一次 TUI 运行期间，切换会话会在内存中分别保留未发送草稿和折叠粘贴原文。Enter 和后续消息快捷键发送展开后的全文。未发送草稿不写入本地文件，也不进入对话或训练导出。重新打开 mycli 时输入框为空，恢复已有会话也一样。

<a id="manage-sessions"></a>

## 管理会话

以下操作不依赖 provider：

```bash
mycli session fork <session-id> [new-session-id]
mycli session rename <session-id> "Release investigation"
mycli session archive <session-id>
mycli session unarchive <session-id>
mycli session delete <session-id> --force
mycli session export <session-id>
mycli session export <session-id> --json
```

任何接受会话 ID 的位置都可以使用唯一标题。标题有歧义时直接失败，不替用户选择会话。归档可撤销；删除是逻辑墓碑，默认隐藏且需要 `--force`，不重写原始存储，也不静默移除后代会话。管理命令不能重命名、归档或删除仍有活动或失效所有者记录的会话。

普通导出返回大小受限的用户与助手文本及脱敏会话元数据，不包含 API Key、认证存储记录、加密推理、provider 请求体、工具参数和输出或原始 SQLite 行。

<a id="training-data-export"></a>

## 训练数据导出

将完整对话导出到一个**新的**本地 JSONL 文件：

```bash
mycli session export <session-id> --training --output ./conversation.jsonl
```

在 TUI 内导出当前会话：

```text
/export
```

无需参数。文件保存在当前工作区，使用唯一名称，例如 `session-2026-09-15T10-30-00-000Z-a1b2c3d4.jsonl`。TUI 显示完整路径以及消息、工具、推理和图片数量。每次导出都会创建新文件。

**一个会话对应一行 JSONL。**该行包含 `schema_version: 3`、`source.session_id`、`messages` 和 `tools`。消息包含一次已保存的系统提示词、上下文指令、用户消息、助手中间文本与明文推理、工具调用和结果，以及最终答案。每条实际消息按对话顺序出现一次，包括失败或中断的执行。用户或助手真实重复发送的消息仍保留为不同出现记录。

```json
{
  "schema_version": 3,
  "source": { "session_id": "session-1" },
  "messages": [
    { "role": "system", "content": "Stored instructions" },
    { "role": "user", "content": "Read src/app.ts" },
    { "role": "assistant", "content": "Reading the file.",
      "reasoning": [{ "kind": "thinking", "text": "Stored plaintext thought" }],
      "tool_calls": [{ "id": "call_1", "type": "function",
        "function": { "name": "Read", "arguments": "{\"file_path\":\"src/app.ts\"}" } }] },
    { "role": "tool", "tool_call_id": "call_1", "content": "Stored file contents" },
    { "role": "assistant", "content": "The entry point is…" }
  ],
  "tools": [{ "type": "function", "function": {
    "name": "Read", "description": "Read a file.",
    "parameters": { "type": "object", "properties": { "file_path": { "type": "string" } } }
  } }]
}
```

导出器读取原始对话（包括压缩前的消息）及保存的提示词/上下文数据。只读取第一个请求以恢复初始指令和继承的分叉前缀，不导出请求快照，也不为每个模型步骤重复累计历史。压缩替换尾部和 UI 状态事件不会追加到对话。保存的上下文更新只插入一次，不重复未变化的 hint。`tools` 包含去重的已保存函数定义，不为每个请求复制一份；会话中发生变化的定义会保留不同版本。

明文思考使用 `reasoning: [{kind: "thinking", text: "…"}]`；返回的推理摘要使用 `kind: "summary"`。加密块、重放签名和不透明的 provider 传输状态不属于明文推理。用户/工具图片通过 `images` 保留 `mediaType`、base64 `data` 和可选 `detail`，与原始消息一起出现，图片字节不经过文本脱敏。调用使用会话内 ID（`call_1` 等），结果引用相同 ID，即使 provider 跨轮次复用原生 ID 也不冲突。失败的工具结果包含 `is_error: true`。未完成调用和无效的已保存参数会保留供后续整理，不静默过滤。

JSONL 以单行流式写入仅所有者可访问的临时文件，再原子发布。不覆盖已有输出或符号链接。父目录必须存在，相对路径从当前工作区解析。取消或失败会删除临时文件，不发生模型调用、训练任务或上传。空会话也生成一行，消息和工具均为空。

CLI 的 `--json` 打印报告。`/export` 显示消息、工具调用/结果、推理块和图片数量，以及凭据脱敏次数和不可用的旧版/上下文数据。导出仅在会话空闲时运行，并持续持有会话控制权直到完成；退出会取消导出。

已知凭据替换为 `[REDACTED]`，已知工作区/主目录路径替换为 `[WORKSPACE]`/`[HOME]`。工具 schema 属性名和多行格式保持完整。分享或训练前，应检查代码、个人数据、图片和未识别的密钥。这是与 provider 无关的对话格式，需要自行适配训练框架，不自动过滤样本或分配目标权重。旧的 `--samples-only`、`--include-tool-errors` 和 `--max-sample-bytes` 选项已移除。

导出不额外截断文本。工具输出在存储前可能已被限制为 8,000 字符。历史逐 token 流式分块和时序没有持久化，无法重建。不带 `--training` 的普通 `session export` 仍是大小受限的可读文本导出。

<a id="readable-session-files"></a>

## 可读会话文件

`~/.mycli/sessions/<session-id>/session.json` 是可读诊断快照，在轮次结束边界以及准备已保存会话时刷新，不逐 token 更新。现有文件在下一次刷新时补充信息，JSON schema 版本仍为 `2`。

| 字段 | 含义 |
| --- | --- |
| `session_id`, `cwd`, `created_at`, `updated_at` | 会话标识、工作区和已保存时间戳。 |
| `state` | 快照交互状态，例如 `idle`、`waiting_approval` 或 `interrupted`。 |
| `message_count` | Provider 对话项数量，不是可见对话行数。 |
| `session` | 线程 ID、已保存生命周期状态、压缩次数（`summary_count`），以及可选标题、父会话/分叉关系和上一轮状态。 |
| `last_request` | 最后记录请求的 provider、协议、模型、推理强度、请求/轮次/步骤 ID、时间戳和指令/工具集快照引用；首次请求前不存在。 |
| `coverage` | 从 SQLite 事件投影出的可读历史范围和省略信息。 |
| `transcript` | 用户/助手文本、可读推理摘要、合并后的工具调用/结果，以及可见生命周期提示。 |
| `subagents`, `links.events` | 子会话产物索引和辅助 `events.jsonl` 路径。 |

`last_request` 描述最后记录的请求，即使之后通过 `/model` 选择了其他模型也不改变。若存在 `model_input_event_count`，它表示该请求的 provider 可见时间线事件数，不是 token 数或 `transcript` 长度。快照 ID 指向 SQLite 中对应记录；提示词文本、工具 schema、凭据、provider 请求体和加密推理不会复制进此文件。生成快照不调用模型。

快照最多读取**最近 2,000 个原始事件**，保留**最后 500 个投影项**。原始窗口截断某个轮次时，最早的不完整轮次会被省略。工具调用与结果合并，内部上下文事件隐藏，因此事件数和可见项数不同。

- `coverage.included_events` 以及 `first_event_sequence` / `last_event_sequence` 描述移除不完整轮次后、应用 500 项上限前的原始窗口。空窗口的序号为 `null`。
- `coverage.included_items` 是 `transcript` 的实际长度。
- `coverage.omitted_items_in_window` 统计因 500 项上限而移除的投影项。
- `coverage.has_older_events` 表示原始窗口之外还有历史。
- 任一上限省略了历史时，`coverage.history_truncated` 为 true。即使 `transcript` 为空也可能为 true，例如单轮事件已经超过原始窗口。
- `coverage.truncated_items` 统计保留项中内容被缩短的数量。长文本、输出、命令、选定输入字段和 diff 保留最多 **8,000 字符**的头尾预览、省略标记及 `truncated` / `omitted_chars`。同一项多个字段被缩短时，`omitted_chars` 报告最大单字段省略量，不是总和。

工具在 `metadata.input` 中保留选定输入字段：Read 的文件和 offset/limit、Shell 的工作目录和 PTY 设置、工具发现查询，以及文件/图片目标。旧 Grep、Glob、LS 记录保留受支持的搜索条件。例如：

```json
{
  "id": "turn-1:tool-call:read-1",
  "turn_id": "turn-1",
  "type": "tool",
  "tool_name": "Read",
  "call_id": "read-1",
  "command": "src/app.ts",
  "status": "completed",
  "output": "...readable file preview...",
  "metadata": {
    "input": { "file_path": "src/app.ts", "offset": 10, "limit": 20 },
    "success": true,
    "actualStartLine": 10,
    "actualEndLine": 29
  }
}
```

任意 MCP 参数、环境变量值、修改操作输入正文和私有理由不包含在内。文件仍可能包含私有对话文本、命令和可读输出。它使用仅所有者可访问的权限原子写入。缺少新增可选字段的旧 v2 文件仍然可读；没有 `coverage` 代表覆盖范围未知，不代表文件完整。

这不是完整备份。完整历史和 provider 重放以 SQLite 为准。SQLite 不可用时，有效的 v2 文件可供只读查看，但无法重建模型上下文或恢复执行。`events.jsonl` 只包含辅助产物事件，同样不是完整权威对话。

<a id="session-scoped-settings"></a>

## 会话级设置

已建立的会话固定 provider、协议、模型、端点标识、凭据引用、推理强度、协作模式和权限配置。这些值跨进程重启保留，不改变用户默认值。新会话或缺少某项固定值的旧会话使用当前该项默认值。工作目录仍归权威会话记录管理，不由偏好数据管理。

通过 `/status` 检查活动会话生命周期、锁、恢复状态、有效权限和沙箱就绪状态。会话摘要只暴露 `owned`、`active`、`stale` 或 `unlocked` 锁状态，不暴露原始进程标识。
