# mycli Shell TUI

[English](../../tui/mycli-shell/README.md) | **简体中文** | [中文目录](README.md)

TUI 消费标准 gateway 契约并呈现终端交互。轮次执行、存储、provider、工具权限和 Shell 进程仍由后端管理。

<a id="module-ownership"></a>

## 模块职责

| 源码路径 | 职责 |
| --- | --- |
| `index.ts` | 公开包 API；内部模块直接导入所属文件 |
| `gateway.ts` | 公开 gateway 入口、启动/关闭导出、独立信号连接 |
| `application/` | Gateway 会话组装、交互/原生运行时、UI 回调和会话生命周期 |
| `state/` | 传输到视图转换、事件归属/reducer、输入队列、设置、目录和历史恢复 |
| `transcript/` | 与显示组件无关的分组、搜索分类、详情投影和重放限制 |
| `components/transcript/` | 对话单元、共享块工厂/渲染器、视口和历史查看器 |
| `components/selectors/` | 审批、澄清、设置、模型/会话选择及首次设置 |
| `components/composer/` | 编辑器、队列预览、工作摘要和会话页脚 |
| `components/shared/` | 可复用布局、Markdown 主题、截断和帧缓存 |
| `interaction/` | 类型化 UI 操作、快捷键、slash 命令和计划选项 |
| `transport/` | 共享 gateway 客户端适配、事件去重、握手和配置传输 |
| `platform/` | TTY 流、剪贴板和致命诊断持久化 |
| `theme/` | 语义颜色和终端字符策略 |
| `tui-core/` | 应用无关终端引擎、屏幕缓冲、输入解码和基础组件 |
| `model.ts` | 共享视图类型、对话更新提示和纯视图模型查询 |

`safe-ui-text.ts`、`stable-variant.ts`、`version.ts` 为包级基础组件；`demo.ts`、`setup.ts` 保持可执行入口。测试尽量对应源码归属，跨功能回归留在 `test/`，可复用数据位于 `test/support/` 和 `test/fixtures/`。

<a id="state-and-rendering"></a>

## 状态与渲染

```text
gateway notification
  -> transport/gateway-events: decode and deduplicate
  -> state/runtime-event-reducer: check ownership and update runtime state
  -> state/runtime-projection: map runtime state to MycliShellState
  -> transcript/: apply detail mode and group read/search activity
  -> components/transcript/transcript-block: create or update cells
  -> components/transcript/transcript-viewport: retain rows and scrollback
  -> tui-core/: render terminal cells

keyboard input
  -> interaction/ui-actions
  -> application/gateway-session
  -> configured gateway transport
```

`state/runtime-event-reducer.ts` 是分发入口，将 Shell、工具、消息、计划、子 Agent、决定和队列交给各自模块。`session-state.ts` 组装纯引导/恢复转换，`transcript-history.ts` 合并页面和旧记录。`application/session-transition.ts` 为 slash 和会话选择器统一管理异步历史恢复；注入加载器读取历史，session generation 与加载修订阻止迟到响应替换新会话或已清空视图。

`RuntimeStateProjector` 将视图映射绑定到 `runtime-transcript-projector.ts` 增量缓存。事件处理不依赖渲染组件。状态生成的旧推理/压缩标签可用 `theme/terminal-style.ts` 字符，但 state 不能依赖终端引擎或组件层。

`application/shell-runtime.ts` 管理交互会话，连接编辑器、选择器、对话、状态和页脚。视口缓存、活动动画、工具详情投影和单元创建分别归独立模块。静态、原生和历史输出与交互渲染共用块工厂。

<a id="composer-layout"></a>

## 输入区布局

当前活动跟随最后输出，中间空一行。剩余空间放在活动下方、工作摘要和编辑器上方。即使对话短或活动出现/消失，编辑器和页脚仍固定底部。

输入区从上到下职责固定：

1. 当前轮次活动跟随 Agent 输出，位于输入摘要之前，管理耗时、中断提示和有界重试详情。实时状态不在页脚重复，也不提交到历史。
2. 工作摘要组合 Goal 和后台 Shell 数，空间允许时显示目标控制和 `/ps`。Plan 进度出现在对话更新中。扩展状态最多额外一行，去掉重复/空项并统计溢出。
3. 排队消息和后台 Agent 在编辑器上方有各自有界预览。
4. 编辑器下方第一行左侧是模式/信任、模型和推理，右侧上下文用量；第二行工作区/分支和会话名。

`tui.statusbar_mode = "full"` 显示两行，`"compact"` 只第一行，`"off"` 隐藏。没有模型上下文时 compact 回退工作区信息。工作摘要和待决交互独立可见；`terminal_progress` 继续控制活动指示。

元数据沿用编辑器内缩并避开终端换行列。窄宽度先省略推理/分支再截断长标签，信任/模式和 Goal 优先。精确用量与继续次数可用 `/goal` 查看。只更新工作状态时，仅使摘要失效，不重建页脚/对话。

<a id="input-and-pasted-text"></a>

## 输入与粘贴文本

普通文本行内显示。Bracketed paste 超过 1,000 Unicode 字符或 10 行时折叠为 `[paste #1 1234 chars]` 或 `[paste #1 +25 lines]`。标记为原子编辑项，删除再撤销会恢复关联原文。Enter 和后续消息快捷键展开全部绑定粘贴后提交，只展开一次，原文里像标记的文字仍按字面保留。

未发送输入和粘贴原文仅保存在内存。同次 TUI 切会话保留各自草稿、光标、图片描述和 skill 引用。提交失败恢复源会话输入并保留更新文本。重启后输入框为空，不写盘或从本地文件恢复草稿。

未发送草稿不属于历史/训练导出。已提交消息用全文进入原有对话流程。折叠不减少上下文用量，大粘贴仍按编辑器既有文本规范化后全文提交。

<a id="integration-inspection"></a>

## 集成查看

`/mcp [verbose]`、`/plugins`、`/skills`、`/hooks` 在发现和设置中心各有独立入口。`/tools [list|sets]` 为仅搜索可见的诊断清单。废弃 `/tools plugins`、`/tools hooks`、`/tools extensions` 由后端返回替代提示。

MCP 条目使用 `type: "mcp"`，代表服务器，含加载、禁用、失败和缓存状态。插件条目代表包，能力显示在详情；插件 MCP 同时出现在 MCP 目录，工具出现在工具清单。

`CommandResultOverlayComponent` 管理过滤、导航和可滚动详情。Enter 仅查看，不调用工具/命令。Esc 先返回再关闭，缩放保留选择和草稿。原文此处的插件包管理入口为 CLI；支持范围见[插件兼容性](plugin-codex-parity.md)。

<a id="invariants"></a>

## 不变约束

- 内部直接导入，不通过包门面绕转实现。
- `tui-core/` 不导入 application、state、theme 或产品组件。通用图片路径检测属于终端图片支持，附件占位符分配属于应用。
- 组件只消费视图模型和回调，不直接使用 gateway 或 reducer。
- `transcript/` 计算显示数据，不导入组件/应用控制器。
- 只有 `transport/` 导入 `@mycli/gateway`；整个 TUI 可用 contracts，不导入后端实现。
- 恢复时保留不可变事件状态、活动会话/generation 检查和来源 ID，迟到回调不能夺取其他会话 UI 或替换状态。
- 激活会话先清原对话再接新事件；历史恢复保留已恢复决定、后台终端和更新实时行。
- 扩展更新后刷新命令面板、补全和两套路由表。打开面板读取当前轮次可用性；打开会话选择器刷新列表但保留草稿。
- 本地 `transcript.clear`、`view.set` 只改 gateway 会话 UI，不改后端历史/用户配置，普通 gateway 更新不能撤销。
- 流式输出期间助手和运行工具组件保持稳定。助手更新不序列化完整块，展开 Shell 保留耗时钟。
- 修改可见内容前增加内容修订。已验证尾部提示保留稳定前缀，会话替换或分组上下文变化使其失效。
- 原生回滚历史提交、查看器生命周期与状态动画分离。

`test/architecture.test.ts` 检查依赖方向、未解析内部导入、后端隔离和循环，含纯类型导入。包类型检查也拒绝未使用变量/参数。

<a id="verification-and-packaging"></a>

## 验证与打包

```sh
npm run typecheck --workspace mycli-shell-tui
npm test --workspace mycli-shell-tui
npm run build
```

公开子路径保持 `.`、`./gateway`、`./gateway-transport`。开发使用 `mycli-source`，普通消费者加载 `dist/`。构建先清理 dist，防止移动文件留下过时编译模块。根测试和打包冒烟验证源码、JavaScript 和声明解析。

<a id="operation-feedback"></a>

## 操作反馈

`/compact` 立即显示 **Compacting context** 和独立计时，Esc/Ctrl+C 一次取消。完成、取消、失败分别显示，重复压缩各有记录。自动压缩后恢复 Working 计时。编辑器/页脚固定底部，实时活动紧靠 Agent 输出。

模型变化确认 provider/模型、推理及会话/用户范围。审批决定在当前对话可见。常规信息用中性样式，警告/失败保留颜色。空闲 Ctrl+C 在输入下显示退出提示，两秒或继续输入后清除。

MCP 启动显示服务器进度，失败指向 `/mcp`。慢 hook 显示阶段，失败指向 `/hooks`。设置加载失败解释回退。Goal 预算中断包含 `/goal` 恢复指引，恢复后含义保留。重试行显示动作/原因，展开可看 provider 和预算详情。

终端报告未聚焦时默认启用通知，提示轮次结束或审批、答复、计划审查请求，不含对话内容。可在 `/settings` 切换 **Terminal notifications**，或用户配置设 `tui_terminal_notifications = false`。通知用 OSC 9，终端需支持焦点报告和通知；运行时停止时清理。

Gateway 断连打印会话恢复命令，不自动重新连接已退出后端。账号配额预警也依赖 provider 配额数据，不从上下文或本地 token 数推断。
