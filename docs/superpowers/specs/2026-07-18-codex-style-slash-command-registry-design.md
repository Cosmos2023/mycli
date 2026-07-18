# Codex 风格 Slash Command 注册表设计

## 目标

把 mycli 当前分散的 slash command 定义收敛成一套中央注册表，并让 CLI、Gateway 和 TypeScript TUI 都从这套注册表获得一致的命令名称、描述、别名、可见性和执行策略。

改完以后需要达到这些效果：

- 命令面板只展示常用的正式命令，不再同时展示正式命令和多组同义写法。
- 常用短命令成为正式名称，例如 `/usage`、`/context`、`/ps` 和 `/undo`。
- 旧的层级命令继续兼容输入，但作为隐藏别名，不再占用命令面板空间。
- CLI 帮助、CLI 补全、TUI 命令面板、TUI 自动补全和 Gateway 分发使用同一份元数据。
- 未知命令和当前状态下不可用的命令不会作为普通用户消息发送给模型。
- 平台、feature、运行状态和界面能力可以统一控制命令可见性。

## 当前问题

mycli 当前有三套相互独立的命令定义：

1. `src/mycli/cli/slash_commands.py` 保存后端补全候选。
2. `src/mycli/cli/repl.py` 保存帮助文本、别名归一化和实际分发逻辑。
3. `tui/mycli-shell/src/shell-runtime.ts` 保存 TUI 命令面板、描述和本地执行逻辑。

Gateway 还在 `src/mycli/cli/node_tui/gateway.py` 中单独维护 command overlay 集合和少量命令描述。

这些定义已经产生可观察的不一致：

- `/theme`、`/mark` 和 `/release-notes` 出现在补全中，但没有完整的执行实现。
- `/help` 能被 TUI 特殊处理，却没有稳定地出现在同一套面板定义中。
- `/model`、`/mode`、`/sandbox`、`/permissions`、`/skills`、`/ps` 和 `/stop` 等已支持命令没有完整出现在后端补全目录中。
- `/session` 在 TUI 中打开 session selector，在纯 CLI 中却展示当前 session 信息。
- `/status usage` 与 `/usage`、`/tasks bashes` 与 `/ps`、`/changes undo` 与 `/undo` 同时存在并被不同模块以不同方式展示。
- 新增或修改命令时需要同步多个 Python 和 TypeScript 文件，测试无法保证它们持续一致。

## Codex 的对应做法

Codex 使用一个 typed `SlashCommand` 枚举作为内建命令的中央身份定义，并从同一层元数据派生：

- 命令面板顺序；
- 用户可见描述；
- 正式名称和解析别名；
- 是否支持 inline arguments；
- task 运行期间是否可用；
- side conversation 中是否可用；
- feature、平台和 debug build 可见性。

命令查找、输入补全和 dispatch 都引用同一个 command identity。别名参与解析，但不会作为第二条可见命令出现在面板里。

mycli 是 Python 后端和 TypeScript TUI 的双进程结构，不能直接复制 Rust enum，但可以复制这套原则：Python 持有唯一注册表，Gateway 将经过过滤的 command manifest 发送给 TUI。

## 设计原则

- **单一元数据源**：正式名称、描述、别名、参数策略和可见性只在 Python 注册表声明一次。
- **身份与行为分离**：注册表定义命令是什么；backend handler 和 TUI action handler 定义命令怎么执行。
- **别名不参与展示**：别名只用于向后兼容和输入解析。
- **显式 surface**：CLI 和 TUI 可以看到不同的命令子集，但都由同一规则过滤。
- **显式运行状态**：命令在 turn 进行中是否允许执行由注册表决定。
- **无静默降级**：未知、不可用或 handler 缺失都产生明确错误。
- **不扩大功能范围**：本次只统一已有命令体系，不顺带实现尚不存在的 `/theme`、`/mark` 或 release notes 功能。

## 中央注册表

新增一个 Python slash command registry 模块。注册表使用稳定的命令 ID 和不可变 spec：

```python
class SlashCommandId(StrEnum):
    HELP = "help"
    MODEL = "model"
    USAGE = "usage"
    # ...


@dataclass(frozen=True)
class SlashDispatchPolicy:
    bare_owner: SlashCommandOwner
    inline_owner: SlashCommandOwner | None
    bare_client_action: str | None
    inline_client_action: str | None


@dataclass(frozen=True)
class SlashCommandSpec:
    id: SlashCommandId
    name: str
    description: str
    argument_hint: str | None
    aliases: tuple[str, ...]
    argument_policy: SlashArgumentPolicy
    dispatch_by_surface: Mapping[SlashCommandSurface, SlashDispatchPolicy]
    presentation: SlashCommandPresentation
    available_during_turn: bool
    surfaces: frozenset[SlashCommandSurface]
    platforms: frozenset[str] | None
    feature: str | None
    order: int
```

每个 surface 的 `bare_owner` 和 `inline_owner` 分开声明，因为部分命令具有混合行为：

- 裸 `/model` 由 TUI 打开 model selector，`/model <name>` 由 backend 修改模型。
- 裸 `/resume` 由 TUI 打开 session selector，`/resume <session-id>` 由 backend 直接恢复指定 session。
- 裸 `/tasks` 由 TUI 打开 background task view，带参数的 `/tasks ...` 由 backend 查询或停止具体任务。

部分命令还需要按 surface 使用不同 policy。例如裸 `/model` 在 TUI 中打开 selector，在纯 CLI 中由 backend 展示或修改模型配置；`/help` 在 TUI 中打开 command palette，在纯 CLI 中输出 registry 生成的帮助文本。这个差异必须由 `dispatch_by_surface` 声明，不能重新散落成调用方的命令名特殊判断。

纯后端命令在两个 surface 的 owner 都是 backend；不支持参数的 TUI 命令只在 TUI surface 声明 `bare_owner=tui`，并令 `inline_owner=None`。

当 owner 是 TUI 时，对应的 `bare_client_action` 或 `inline_client_action` 必须存在；backend owner 对应的 client action 必须为空。`platforms=None` 表示支持所有平台，否则只在声明的平台上进入 manifest。

注册表按 `order` 返回命令。顺序是产品界面的一部分，常用命令排在前面，不按字母排序。

## 正式命令集合

TUI 命令面板展示以下正式命令：

| 分类 | 正式命令 |
|---|---|
| 配置 | `/model`、`/plan`、`/mode`、`/permissions`、`/sandbox`、`/settings` |
| 会话 | `/resume`、`/fork`、`/new`、`/status`、`/usage`、`/context`、`/stats` |
| 能力 | `/skills`、`/tools`、`/resources`、`/memory` |
| 任务 | `/agents`、`/tasks`、`/ps`、`/stop` |
| 变更 | `/changes`、`/undo`、`/trace` |
| TUI | `/details`、`/view`、`/hotkeys`、`/copy`、`/clear` |
| 账户 | `/login`、`/trust` |
| 通用 | `/help`、`/quit` |

纯 CLI surface 不展示依赖 TUI 的命令，例如 `/settings`、`/details`、`/hotkeys` 和 `/copy`。手动输入这些命令时返回“仅在交互式 TUI 中可用”，不会进入模型。

`/theme`、`/mark` 和 `/release-notes` 从候选目录移除。以后只有在它们拥有完整 handler、描述和测试时，才能加入注册表。

## 隐藏兼容别名

以下旧写法继续可用，但不出现在命令面板、自动补全和 `/help` 的正式命令列表中：

| 隐藏写法 | 正式命令或等价调用 |
|---|---|
| `/skill`、`/tools skills` | `/skills` |
| `/status usage` | `/usage` |
| `/status context` | `/context` |
| `/status stats` | `/stats` |
| `/tools permissions` | `/permissions` |
| `/tasks bashes`、`/bashes`、`/jobs bashes` | `/ps` |
| `/changes undo` | `/undo` |
| `/session`、`/session list`、`/sessions` | `/resume` |
| `/session show` | `/status` |
| `/session resume <id>` | `/resume <id>` |
| `/session fork ...` | `/fork ...` |
| `/hooks` | `/tools hooks` |
| `/toolsets` | `/tools sets` |
| `/extensions` | `/tools extensions` |
| `/plugin ...` | `/tools plugins ...` |
| `/jobs` | `/tasks` |
| `/subagents ...`、`/jobs subagents ...` | `/tasks agents ...` |
| `/trace-jsonl` | `/trace export` |
| `/logs` | `/trace logs` |

`/session search ...` 和 `/session maintenance ...` 仍作为隐藏 legacy route 保留原有行为。它们不会进入正式命令面板，也不会被错误地改写成语义不同的 `/resume` 调用。

## 解析规则

注册表提供统一的 `resolve_slash_command(text, context)`，返回 command spec、参数和实际 owner。

解析顺序如下：

1. 去除输入两端空白，但不修改参数内部内容。
2. 确认输入以 `/` 开头。
3. 收集所有匹配的正式命令名、隐藏别名和 legacy route。
4. 选择最长前缀；长度相同时正式名称优先于别名。这样 `/status usage` 会解析为 `/usage`，而不是带参数的 `/status`，`/session fork` 也不会被较短的 `/session` 抢先匹配。
5. 根据 `argument_policy` 校验是否允许或要求参数。
6. 根据是否存在参数选择 `bare_owner` 或 `inline_owner`。
7. 检查 surface、feature、平台和 turn 状态。
8. 返回 typed invocation，或者返回明确的 unknown、invalid arguments 或 unavailable 错误。

参数保持原始文本，不通过简单的全字符串替换重建。需要结构化参数的 handler 可以继续使用 `shlex` 或专用 parser。

## Gateway 协议

### `command.list`

Gateway 新增 `command.list`，根据当前 surface、feature、平台和 session 状态返回可见 manifest：

```json
{
  "commands": [
    {
      "id": "usage",
      "name": "/usage",
      "description": "Show token usage",
      "argument_hint": null,
      "argument_policy": "none",
      "available_during_turn": true
    }
  ]
}
```

别名不进入该响应。TUI 不需要知道隐藏兼容写法。

现有 `completion.slash` 在迁移期保留，并从 `command.list` 的结果投影旧格式，避免继续维护第二份候选列表。

### `command.run`

所有 TUI slash command 输入都先发送给 `command.run`，包括 TUI-owned 命令。Gateway 负责唯一一次解析，然后返回以下两种结果之一：

- backend 命令：直接执行并返回 lines、presentation 和状态变更信息；
- TUI 命令：返回稳定的 `client_action` 和必要参数，由 TUI handler 执行。

示例：

```json
{
  "execution": "tui",
  "client_action": "open_settings",
  "args": ""
}
```

这能避免 TypeScript 再实现一份正式名称、别名和参数路由逻辑。

## TUI 改造

TUI 启动后调用 `command.list`，用响应生成：

- slash command palette；
- editor 自动补全；
- 命令描述和参数提示；
- turn 进行中命令的 enabled/disabled 状态。

TypeScript 删除以下静态元数据来源：

- `BACKEND_COMMANDS`；
- `commands()` 中重复的名称和描述；
- `isBackendCommand()` 的静态判断；
- 对 `/help`、`/session`、`/model` 等名称的散落解析分支。

TypeScript 只保留一个以 `client_action` 为 key 的本地 handler map，例如：

```typescript
const localCommandHandlers = {
  open_settings: () => showSettingsSelector(),
  open_model_selector: () => showModelSelector(),
  copy_last_response: () => copyLastAssistantMessage(),
  clear_transcript: () => clearTranscript(),
};
```

收到未知 `client_action` 时显示内部配置错误，不能静默忽略。

## CLI 改造

纯 CLI REPL 使用同一个 resolver 和 backend handler table：

- `/help` 由 registry 自动生成，不再维护手写命令列表。
- 自动补全候选由 registry 生成。
- `canonical_slash_command()` 由 typed resolver 替代。
- backend dispatch 按 `SlashCommandId` 分发，不再反复比较原始字符串。
- TUI-only 命令在 CLI surface 返回明确提示。

为了控制单次改动风险，原有 `build_command_handler()` 可以先作为 handler adapter 保留，但它接收 typed invocation。完成迁移后再删除旧的字符串分发链。

## Presentation 与运行状态

`presentation` 继续保留现有语义：

- `overlay`：状态、usage、context、permissions 等临时信息；
- `transcript`：需要进入可见历史的命令结果；
- `none`：只触发本地 selector、复制、退出等动作。

`available_during_turn` 统一决定命令是否能在 agent turn 运行时执行。不可用命令仍然可以被 resolver 识别，以便显示准确错误，但不会进入模型，也不会被当作普通文本排队。

feature 或平台不可用的命令不显示在 manifest 中。用户手动输入时，resolver 返回 unavailable，而不是 unknown，使错误原因可判断。

## 错误处理

- 未知命令返回 `Unknown command: /name`。
- 不支持参数时返回命令 usage。
- 缺少必需参数时返回命令 usage。
- 当前 surface 不支持时返回“仅在交互式 TUI 中可用”或对应说明。
- turn 进行中不可用时返回“任务运行期间不可用”。
- feature 或平台不可用时返回具体 unavailable 原因。
- backend handler 或 TUI action handler 缺失时返回内部配置错误，并记录诊断日志。
- 任何 slash command 解析错误都不能退化为普通用户消息并发送给模型。

## 注册表完整性检查

注册表在测试中必须验证：

- 正式名称唯一；
- command ID 唯一；
- alias 唯一，且不能与其他正式名称冲突；
- `order` 唯一且稳定；
- 每个可见 surface 都有对应的 dispatch policy；
- 每个 backend owner 都有 backend handler；
- 每个 TUI owner 都有有效的 bare 或 inline `client_action`；
- backend owner 不能携带 `client_action`；
- `argument_policy=none` 时不能声明 inline owner；
- 仅 TUI 可用的命令不能错误出现在 CLI manifest；
- 所有用户可见命令都有非空描述。

## 迁移顺序

1. 增加 typed registry、resolver 和完整性测试，但暂时保留旧 API adapter。
2. 让 `/help`、CLI completion 和 Gateway completion 从 registry 派生。
3. 增加 `command.list`，扩展 `command.run` 支持 backend result 和 TUI client action。
4. 让 TypeScript TUI 从 Gateway manifest 构建 palette 和 autocomplete。
5. 把 TUI 本地命令迁移到 `client_action` handler map。
6. 把 backend 字符串 dispatch 迁移到 `SlashCommandId` handler table。
7. 删除 `BACKEND_COMMANDS`、`_SLASH_COMMANDS`、`_slash_description()`、手写 `/help` 和旧 alias normalization。
8. 增加跨层契约测试，确认 manifest、dispatch 和 TUI handler 一致。

每一步都保持可测试和可回退，避免一次性同时重写 Gateway、CLI 和 TUI。

## 测试范围

### Python

- 注册表完整性检查。
- 正式名称按产品顺序返回。
- aliases 不进入 visible manifest。
- 最长别名前缀正确解析并保留参数。
- `/usage`、`/context`、`/ps`、`/undo` 是正式 identity。
- 旧层级写法解析到相同 identity。
- hidden legacy route 保持现有行为。
- CLI 和 TUI surface 过滤正确。
- turn 和 feature 状态过滤正确。
- backend handler 缺失会失败测试。
- `/help` 与 completion 都由 registry 生成。
- `completion.slash` 与 `command.list` 保持兼容。
- 未知或 unavailable slash command 不进入模型 turn。

### TypeScript

- TUI 使用 `command.list` 构建 palette 和 autocomplete。
- aliases 不出现在面板中。
- 命令顺序与 Gateway manifest 一致。
- backend command 通过 `command.run` 执行。
- TUI command 根据 `client_action` 执行。
- bare 和 inline hybrid command 路由正确。
- turn 进行中 disabled 状态正确。
- 未知 `client_action` 显示明确错误。
- `/help` 和输入单个 `/` 打开同一命令面板。
- 未知 slash command 不调用普通 turn submission。

### 端到端

- `/usage` 与旧 `/status usage` 输出一致，只有 `/usage` 出现在面板。
- `/ps` 与旧 `/tasks bashes` 输出一致，只有 `/ps` 出现在面板。
- `/undo` 与旧 `/changes undo` 行为一致，只有 `/undo` 出现在面板。
- 裸 `/model` 打开 selector，`/model <name>` 修改 backend 配置。
- 裸 `/resume` 打开 selector，`/resume <id>` 恢复指定 session。
- `/theme`、`/mark` 和 `/release-notes` 不再显示。
- CLI 与 TUI 对同一 backend 命令给出一致结果。

## 验收标准

- slash command 正式元数据只存在于 Python registry。
- TUI 不再维护 backend command 名称和描述列表。
- Gateway 不再维护独立的 description 或 overlay 命令集合。
- 命令面板只展示本 spec 定义的正式命令。
- 所有旧别名继续兼容，但不会出现在面板和正式帮助列表中。
- `/session` 在不同 surface 上不再具有冲突语义。
- 命令的可见性、参数策略、presentation 和 turn 状态限制均由 registry 驱动。
- 未知、不可用或配置错误的 slash command 永远不会进入模型上下文。
- Python、TypeScript 和端到端测试覆盖正式命令、别名、混合 owner 和错误路径。

## 非目标

- 不实现新的 `/theme`、`/mark` 或 release notes 功能。
- 不改变普通用户消息、steering queue 或 follow-up queue 的语义。
- 不改变工具调用协议、shell runtime 或 session transcript 格式。
- 不把 plugin 或 skill 动态命令扩展纳入本次第一版；后续可以基于相同 manifest 接口增加动态 command provider。
