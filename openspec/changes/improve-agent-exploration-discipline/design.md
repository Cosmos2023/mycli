## Context

`mycli` 已经完成了两轮关键底座建设：

- `upgrade-responses-agent-runtime` 让 runtime 能初步消费 `Responses` item / event；
- `productize-agent-runtime` 明确了 thread / turn / item / policy / surface 的产品化方向。

但真实 smoke 仍暴露出一个核心问题：当用户要求“分析仓库”时，runtime 会在读取 `README.md` 和列出根目录后过早认为“证据已足够”，导致 agent 基于说明文档直接收口。这说明当前缺口已经不是协议兼容，而是 **agent exploration discipline**。

同时，`openai/codex` 的开源实现表明，成熟 agent runtime 并不依赖单一的“overview 已足够”短路规则，而是把探索节奏、工具偏好、活动事件和最终回答边界共同纳入 runtime 主链。`mycli` 需要在不推翻现有架构的前提下，把这层纪律补上。

## Goals / Non-Goals

**Goals:**

- 为仓库分析类请求建立独立于通用 overview 的任务分类与探索策略。
- 将“证据已足够”的判断从 README 驱动，升级为多源证据驱动。
- 约束 agent 在证据不足时区分事实与推断，降低过度自信总结。
- 让 CLI 能展示更语义化的探索阶段，而不是只显示零散 reasoning 文本。

**Non-Goals:**

- 不在本变更中完整引入 Codex 式 `shell-first` 工具体系替换当前工具集。
- 不重做整套 thread/session 协议；本变更建立在现有 runtime protocol 产品化成果之上。
- 不新增复杂 UI surface；仅增强现有 CLI 活动流的语义质量。

## Decisions

### 1. 将“仓库分析”从通用 overview 中拆成独立策略路径

当前 `RuntimePolicy` 通过关键字匹配把很多请求都归入 overview，再用统一的低门槛证据规则处理。这对“给我一个仓库概览”类请求过于粗糙。

本变更决定新增更明确的 repo-analysis 意图分类，覆盖诸如：

- 仓库用途分析
- 入口文件/主模块梳理
- 架构特点总结
- 基于当前代码组织的简短说明

之所以不继续扩展通用 overview heuristic，是因为这类任务对证据质量更敏感，且更容易被 README 误导。

### 2. 用“多源证据足迹”替换当前 overview sufficiency heuristic

新的 sufficiency 规则不再接受“根目录列表 + 任意一次 read/search”作为充分条件，而要求至少满足以下两层证据：

- 结构证据：至少一次针对仓库根或关键源码目录的 `list_directory`
- 内容证据：至少一份来自真实源码或配置的成功证据，例如 `pyproject.toml`、`src/**` 下文件、或等价核心配置文件

`README.md` 仍然可以作为辅助证据，但单独存在时不得触发强制收口。

之所以不走“完全交给模型自己判断”的方案，是因为当前 `mycli` 的 runtime 已经承担 stop policy，这一层若没有最低证据约束，仍会反复回到 README-only 总结问题。

### 3. 将分析回答契约升级为“确认事实 + 推断边界”

对于 repo-analysis 类请求，prompt 和 runtime reminder 都要显式要求：

- 优先总结已确认事实
- 当某个判断只是由 README 或局部片段推导而来时，要标记为推断
- 若预算耗尽但证据不足，应给出“基于当前证据的简要判断 + 缺失验证点”

之所以采用回答契约而不是只靠 UI 提示，是因为问题根源发生在模型输出阶段，必须在 prompt 和 policy 两层同时约束。

### 4. 为 repo-analysis 增加探索路由偏好

在此类任务中，runtime 应偏好以下探索顺序：

1. `list_directory` 识别根结构与关键子目录
2. `search_text` 或等价检索定位入口/主模块候选
3. `read_file_range` 或小范围 `read_file` 验证关键源码/配置
4. 汇总证据后回答

同时，对大文件和说明文档要更积极地下发 reminder，促使模型改用范围读取或转向真实源码。

这里不直接改成 Codex 那样的 shell-first，是为了保持当前 `mycli` 工具面和安全边界稳定；本变更只补上“在现有工具集合内如何更像成熟 agent”的纪律。

### 5. 复用现有 activity stream，但把探索阶段语义化

本变更不会另起一套新事件协议，而是在现有 turn/activity 流上增加更明确的语义消息，例如：

- 正在检查仓库结构
- 正在定位入口与主要模块
- 正在读取源码确认架构事实
- 已从确认的证据收口回答

这样可以让 CLI 更接近 Codex/Claude Code 的“可见工作过程”，同时避免 raw reasoning 噪音继续泄漏到用户界面。

## Risks / Trade-offs

- [风险] 更高的证据门槛会增加仓库分析类任务的平均步数与延迟。 → 缓解：只对 repo-analysis 类请求启用更严格策略，并保留预算上限。
- [风险] 意图分类过宽会让普通问答也被套上分析纪律。 → 缓解：先基于现有 smoke 场景和关键词做窄启动，并补语言回归测试。
- [风险] 事实/推断提示可能让答案变得更保守、更啰嗦。 → 缓解：只在证据不足时要求显式提示，证据充分时允许简洁回答。
- [风险] 活动语义若直接来自 reasoning 文本，仍可能出现噪音。 → 缓解：优先从 turn item、tool usage 和 policy decision 生成活动语义，弱化对原始 reasoning 文本的依赖。

## Migration Plan

1. 在 `RuntimePolicy` 中引入 repo-analysis 分类和新证据门槛。
2. 更新 prompt 与 context shaping，让模型收到统一的事实/推断与探索路由约束。
3. 将新策略产生的关键阶段写入 turn/activity，供 CLI 渲染。
4. 增补单元测试与 smoke 用例，重点覆盖 README-only 提前总结回归。
5. 以默认开启方式发布；如发现误判，可临时通过配置降低 repo-analysis 检测强度或关闭强制收口。

本变更不涉及持久化 schema 迁移；回滚时只需撤回策略与 activity 语义改动。

## Open Questions

- repo-analysis 分类是否只覆盖“仓库/模块/入口”类请求，还是也应覆盖“解释当前项目架构特点”这类更泛化表述。
- 是否需要在后续变更中补一个更 shell-like 的统一探索工具，以进一步向 Codex 的 repo inspection 路径靠拢。
