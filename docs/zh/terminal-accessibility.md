<a id="terminal-and-accessibility"></a>

# 终端与无障碍功能

[English](../terminal-accessibility.md) | **简体中文** | [中文目录](README.md)

交互式会话启动时，mycli 统一解析一次终端能力。颜色、字符、动态效果和光标选择会随有效设置通过 gateway 发送，因此 TUI 组件不必各自猜测终端行为。

<a id="appearance-settings"></a>

## 外观设置

以下用户设置可以通过 `mycli config set` 修改，也可以在 `/settings` 的 Appearance and accessibility 中修改：

| 设置 | 取值 | 行为 |
| --- | --- | --- |
| `tui.color_mode` | `auto`, `truecolor`, `256`, `16`, `none` | 选择允许的最高颜色深度；`NO_COLOR` 和 `TERM=dumb` 仍会强制无颜色输出 |
| `tui.glyph_mode` | `auto`, `unicode`, `ascii` | 必要时将界面边框、表格、进度和状态字符替换为纯 ASCII |
| `tui.reduced_motion` | `true`, `false` | 使用静态进度指示代替动画帧 |
| `tui.high_contrast` | `true`, `false` | 增强状态和选择样式的对比；无颜色时标签和符号仍能传达含义 |
| `tui.terminal_progress` | `true`, `false` | 显示或隐藏精简的轮次进度，与减少动态效果设置独立 |
| `tui.hardware_cursor` | `true`, `false` | 将真实终端光标置于编辑器插入点，帮助 CJK 输入法定位候选框 |
| `tui.clear_on_shrink` | `true`, `false` | 渲染内容变短时清除残留单元格 |

示例：

```bash
mycli config set tui.color_mode none
mycli config set tui.glyph_mode ascii
mycli config set tui.reduced_motion true
mycli config set tui.hardware_cursor true
```

使用 `mycli config unset <key>` 将标量设置恢复为分层默认值。完整的自动生成设置键和别名清单见 [reference/configuration.md](reference/configuration.md)。

<a id="custom-keymaps"></a>

## 自定义快捷键

快捷键使用结构化 TOML 表，区分 `app`、`editor` 和 `selector` 上下文。值可以是单个按键字符串、多个备选按键的数组，或用于解除可选操作绑定的空数组。

```toml
[tui.keymap.app]
help = "ctrl+h"
command_palette = ["ctrl+p", "f2"]

[tui.keymap.editor]
cursor_word_left = ["alt+left", "alt+b"]

[tui.keymap.selector]
cancel = ["escape", "ctrl+c"]
```

mycli 会统一修饰键顺序，并拒绝未知操作、无效按键、同上下文冲突，以及完全解除必需的提交、确认、取消、中断或退出操作绑定。某一配置层被拒绝时，原先有效的快捷键保持不变。`/settings` 支持搜索实际生效的操作、按键和来源。选择 `Reset keymap` 只删除用户快捷键表并恢复分层默认值，不影响其他设置。

<a id="input-and-resize-behavior"></a>

## 输入与窗口缩放

- CJK 和 emoji 按终端单元格宽度换行或截断，不使用 JavaScript 字符串长度。
- Bracketed paste 会缓冲到结束标记，即使输入分块到达也是如此。大段粘贴以原子编辑标记显示，提交时展开为原文。
- 所有选择器均可通过键盘访问。`Esc` 取消或返回上一层，除非当前操作定义了中断行为，否则不会丢弃输入框草稿。
- 窗口缩放会根据对话源数据重新构建。回归测试覆盖 60、80、100、140 列，以及快速缩小/放大和宽字符残留清理。
- Emoji、Nerd Fonts、鼠标和真彩色均为可选能力。`TERM=dumb` 自动使用无颜色和 ASCII 回退。

<a id="shell-and-automation-behavior"></a>

## Shell 与自动化行为

Read、旧搜索/列表工具和可识别的 Shell 搜索共用 `Exploring`/`Explored` 摘要，单次操作也一样。连续读取会在一个 `Read` 行中合并去重后的文件名。搜索显示 `Search <keywords> in <paths>`，文件发现显示 `List <path>`。操作标签使用强调色，目标使用普通文字。各行采用悬挂缩进换行，不固定限制目标数量。助手消息、普通命令、修改操作和轮次边界会结束分组。失败和取消保留明确状态，包括读取失败后成功重试的情况。

简单的 POSIX `rg`、`grep` 和 `rg --files` 调用由 `shell-quote` 与 Node 参数解析器识别，解析只影响展示。不支持的选项、管道、重定向、展开以及非 POSIX Shell 保留原始命令显示。读取范围、空/未变化读取摘要、搜索过滤和结果保留在展开工具视图和 `Ctrl+T` 对话视图中。Shell 详情保留原始命令和输出。退出码为 1，且既没有保留输出也没有省略输出时，不视为搜索失败；详情显示 `No results`（或 `No files found`）及原始退出码。诊断、中断和超时仍明确显示为失败。

Shell 审批使用语法着色、淡背景的命令预览，并可显示一行 `Reason`。优先使用模型提供、经过清理的 `justification`；缺失时使用运行时策略说明；两者都没有则省略。不另设 `Approval` 行，也不额外调用模型补充原因。恢复已保存审批时使用相同规则。

模型请求 `require_escalated` 时，提供作为审批问题的 `justification`；普通 Shell 调用省略该字段。模型可见的 Shell schema 不包含 `description`；带有此字段的旧调用仍可执行并保留原始记录。原因有长度限制、凭据脱敏和终端安全处理，恢复会话后也适用。风险和持久授权规则使用独立标签，选中的决定整行高亮。无颜色终端保留命令、选择标记和数字选项。长命令仍可在全文检查视图查看；窗口缩放会保持命令和当前选项可见。审批选项及快捷键不变。

`Shell` 和 `WriteStdin` 默认返回约 500 个 token。`max_output_tokens` 可请求更多输出，最多约 2,000 个 token（共享的 8,000 字符结果上限），或运行时配置的更低上限。截断会保留开头和结尾。未指定预算的旧 Shell 调用也使用相同默认值。

后台终端输入先显示 `Interacting with background terminal`，随后显示 `Interacted with background terminal`，附带原始命令和大小受限、脱敏的输入预览。空白与控制输入可见，包括 `^C` 和 `^D`。空 `WriteStdin` 调用显示 `Waiting for background terminal`；只有轮询返回时进程仍运行，才会在对话中保留 `Waited for background terminal`。观察到进程完成的轮询不增加等待行，输出继续更新原来的 Shell 块。即使进程以失败状态退出，成功发送 Ctrl+C 仍算交互；写入失败和调用中断有明确错误状态。已完成交互记录可在恢复会话后保留；缺少明确安全预览的旧记录继续隐藏输入。

交互聊天要求 stdin 和 stdout 都是终端。否则 mycli 输出一条简短的 `tty_required` 诊断并退出，不启动后端或 TUI。`config`、`doctor`、`session` 和 `completion` 等无需 provider 的命令，在管道和 CI 中仍是普通 stdout 命令，不输出全屏控制序列或进度动画。

无需启动 provider 或交互运行时即可生成 Shell 补全：

```bash
mycli completion bash
mycli completion zsh
mycli completion fish
mycli completion powershell
```

各 Shell 的加载命令见 [commands.md](commands.md#shell-completion)。

<a id="compatibility-checklist"></a>

## 兼容性检查清单

终端显示异常时，按顺序检查：

1. 运行 `mycli config get tui.color_mode` 和 `mycli config get tui.glyph_mode`。
2. 检查 `NO_COLOR`、`TERM`、`COLORTERM` 以及 locale（`LANG` 或 `LC_ALL`）。
3. 旧控制台、串行终端或受限 SSH 场景使用 `tui.glyph_mode = "ascii"`。
4. 输入法候选框偏离编辑器时，使用 `tui.hardware_cursor = true`。
5. 运行 `mycli doctor` 查看大小受限的终端和沙箱诊断；输出不包含原始环境变量值和凭据。
