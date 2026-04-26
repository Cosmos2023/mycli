# mycli 对照 Codex 的下一步动作建议

**日期：** 2026-04-12

**状态：** 建议收敛，可作为后续 OpenSpec proposal 的决策依据

**适用范围：** 承接 `mycli` 现有阶段性路线图、Codex runtime 主链调研结论，以及“向通用个人 AI assistant 演进”的长期目标

---

## 1. 这份文档回答什么问题

在看完 Codex 的源码之后，最容易冒出的一个问题是：

`既然 Codex 看起来已经很成熟，那么 mycli 下一步到底应该先做什么？`

这个问题如果回答得太浅，容易变成：

- 去补更多 Responses 事件
- 去接更多工具
- 去加 skills / MCP / multi-agent

这些方向本身并不错，但如果没有更高一层的判断标准，就会重新回到“功能看起来越来越多，但主链没有真正变稳”的老问题。

所以，这份文档的目标不是重复讲一遍 Codex 做了什么，而是把调研结论转成 `mycli` 可以执行的下一步建议。

一句话概括：

`Codex 最值得借鉴的不是某个单点功能，而是“先做稳统一 agent runtime 主链，再让更多能力挂上去”。`

---

## 2. 先说结论

如果把 `mycli` 的目标明确为“通用 agent”，而不只是“会分析仓库的工具”或“coding CLI”，那么下一步最重要的事情不是继续扩 capability 面，而是优先补齐下面四层。

1. **通用任务的探索与收口策略层**
   - 解决 agent 何时探索、探索到什么程度、何时切换路径、何时回答

2. **正式的动态工具协议层**
   - 解决工具不是“能接就行”，而是生命周期、可见性、冲突处理都统一

3. **provider / MCP / hosted tool bridge**
   - 解决外部工具如何真正进入主链，而不是变成协议旁路

4. **多任务 capability 产品化层**
   - 解决 coding / debugging / writing / research / automation 如何共存于同一个 runtime

这四层的排序，决定了 `mycli` 未来会长成：

- 一个越做越散的多功能 CLI

还是：

- 一个可持续进化的通用 agent runtime

---

## 3. Codex 真正值得借鉴的点，不是“会很多”，而是“收得住”

Codex 的源码给出的最重要信号，不是它集成了多少功能，而是它把能力收敛进了统一主链。

从 `build_initial_context()`、`built_tools()`、`build_prompt()`、`run_sampling_request()` 这条链路可以看出，Codex 的核心思路是：

1. 先组装本轮完整上下文
2. 再决定本轮可见工具面
3. 再把模型输出统一映射成 item / event
4. 再把工具调用统一送入 router
5. 最后让 history、state、surface 都消费同一套运行时对象

这意味着：

- skills 不是外挂 prompt
- MCP 不是单独工具系统
- UI 不是自己猜模型意图
- 多 agent 也不是主链之外的特殊分支

它们都只是统一主链上的不同接入点。

这件事对 `mycli` 的启发非常直接：

`不是先把更多能力做出来，而是先把“能力如何进入 turn 主链”这件事做稳定。`

---

## 4. 当前 mycli 真正缺的，不是能力，而是中层

从现状看，`mycli` 并不是没有在朝正确方向走。

当前已经完成或基本站稳的部分包括：

- turn context assembly 的第一版骨架
- capability injection 的初步产品化
- tool exposure / router 的第一版主链接入
- responses 适配与 trace 可见性增强

这些都说明方向没有跑偏。

但和 Codex 相比，`mycli` 现在最明显的缺口，不在最底层，也不在最顶层，而在中间层。

### 4.1 缺少稳定的“任务推进策略层”

现在最容易暴露问题的样本场景是：

- 代码库类分析任务容易只读 README 就收口
- 证据型任务容易被日志、变更提案、model raw 文件带偏
- 拿到足够线索后还会继续重复探索

这些表面上看像是“仓库分析问题”，但本质上其实是：

`agent 还没有稳定的探索、验证、收口策略层。`

如果这层不补，后面做：

- 写代码
- 修 bug
- 写作
- 调研
- 自动化

都会以不同形式重复出现同样的问题。

### 4.2 缺少稳定的“工具协议层”

现在 `mycli` 已经有了 tool exposure 和 routing 的骨架，但 dynamic tools 仍然更像“接得进去的对象”，还不是“正式 runtime 对象”。

一旦未来加入：

- 更多 capability contributed tools
- provider-specific tools
- MCP tools
- 写作或研究相关工具

没有正式 descriptor、lifecycle、trace、scope、conflict handling，工具面就会继续发散。

### 4.3 缺少稳定的“外部能力桥接层”

Responses / hosted / provider-specific item 生命周期仍不完整，MCP 也还没有真正被桥接成主链内能力。

这意味着：

- provider 差异还容易一路泄漏到 runtime 和 surface
- 工具接入还是偏“协议适配”，不是“能力集成”

### 4.4 缺少稳定的“任务类型产品化层”

现在的 `mycli` 已经有 capability 方向，但还没有真正把不同任务类型建模成正式 capability / workflow profile。

于是会出现一个风险：

- 继续做下去，很容易让不同任务只能靠 prompt 微调去区分

而不是：

- 由 runtime 明确知道“这是 coding turn、debugging turn、writing turn 还是 research turn”

---

## 5. 为什么当前看起来像在优化“探索代码仓库”

这个错觉是真实存在的，但原因不是路线选错了，而是当前暴露问题最严重、也最容易观察的样本场景恰好是“探索代码仓库”。

之所以最近很多 change 看起来都和代码库分析有关，是因为它恰好具备三个特征：

1. 容易观察 agent 是否真的在探索
2. 容易看到证据是否充分
3. 容易暴露何时该收口、何时不该继续读

所以它是一个高信号样本任务，而不是产品目标本身。

但如果从架构角度重新描述，当前在补的并不是“仓库分析优化”，而是：

- 通用探索策略
- 通用证据门槛
- 通用收口机制
- 通用工具暴露纪律

这些抽象将来同样服务于：

- debugging
- implementation audit
- writing with references
- structured research
- automation verification

因此，接下来的文档和 proposal 表述，需要始终避免把这条主线叙述成：

`mycli 正在做一个更会探索代码仓库的 agent`

而应该表述成：

`mycli 正在补齐一个通用 agent 的探索与执行主链。`

换句话说：

- `repo analysis` 只是当前用来暴露 runtime 缺陷的高信号样本任务
- 它不应继续主导 `mycli` 的产品叙事
- 后续 proposal、design 和验证集都应显式覆盖 debugging、writing/research、assistant automation，而不是只围绕代码库分析展开

---

## 6. 对 mycli 的下一步建议

结合 Codex 的主链设计和 `mycli` 当前状态，建议下一步按下面顺序推进。

## 6.1 第一优先级：稳定通用探索与收口策略

对应当前 proposal，可以继续沿 `stabilize-agent-runtime-decision-policy` 推进，但要明确其定位：

`不是仓库分析优化，而是通用 agent 的探索 / 验证 / 收口策略层。`

这一步应重点解决：

- 按任务类型选择探索路径
- 搜索结果噪音降权
- 源码主路径优先
- enough evidence 的正式判定
- 重复探索前的换路或回答
- 截断读取后的续读策略

这一步排第一，不是因为它最“显眼”，而是因为它是后续所有高阶能力的质量前提。

如果这层不稳，继续加工具，只会把 agent 的犹豫、漂移和重复行动放大。

## 6.2 第二优先级：把 dynamic tools 升级成正式协议

这一阶段建议用新的 OpenSpec change 明确做 `formalize-dynamic-tool-contract`。

它应解决：

- dynamic tool descriptor
- turn / thread scoped lifecycle
- runtime-generated 与 capability-contributed tool 的统一声明
- trace / session / surface 的统一可见性
- 冲突、去重、优先级规则

Codex 的经验说明，工具不是“能调起来就行”，而是必须成为稳定的 runtime 对象。

## 6.3 第三优先级：建立 provider / MCP bridge

在本地主链和 dynamic tools 协议都更稳之后，再接 provider-specific / hosted / MCP bridge。

这一层应解决：

- provider item lifecycle 的完整适配
- namespaced provider route 的正式桥接
- provider tool metadata / error / trace 的归一化
- MCP 的最小稳定主链接入

这一步不能太早做，因为它最容易放大复杂度。

没有前两层，bridge 会更像“接了一堆外部入口”；有了前两层，bridge 才会真正变成“能力扩展”。

## 6.4 第四优先级：把多任务能力做成正式 capability profile

当 runtime 的决策层和工具层都更稳之后，才值得推进多任务 capability 产品化。

这一步的重点不是“加几个新 prompt”，而是正式定义：

- coding
- debugging
- implementation audit
- writing
- research
- automation

这些任务类型在 runtime 中分别意味着什么：

- 默认探索方式是什么
- 默认回答结构是什么
- 默认验证要求是什么
- 默认可见工具面是什么
- 哪些场景下需要更强约束或更强自主性

只有走到这一步，`mycli` 才开始真正从“偏 coding 的 agent”走向“通用 assistant”。

---

## 7. 接下来不建议优先做什么

为了保持路线收敛，接下来有几类事情不建议抢在前面做。

### 7.1 不建议优先做“更多单点功能演示”

例如：

- 再接几个工具
- 再补几个 provider 事件
- 再加几个 task mode

这些都可能有价值，但如果先做，会再次把系统带回“功能增加，但主链没变稳”的状态。

### 7.2 不建议优先做“按任务类别分裂产品形态”

例如：

- coding mode 一套逻辑
- writing mode 一套逻辑
- research mode 一套逻辑

这会很快把系统变成多个弱耦合小系统，而不是一个通用 agent。

### 7.3 不建议优先做“为了表面像 Codex 而做的 UI/功能模仿”

Codex 值得借鉴的是架构收敛方法，不是表面功能罗列。

例如：

- 有 multi-agent 按钮
- 有更多状态展示
- 有更多 tool schema 暴露

如果没有主链支撑，这些只会制造“看起来更像”，不会制造“实际上更稳”。

---

## 8. 建议如何与现有路线文档衔接

这份文档不是替代已有文档，而是对它们做一次“决策层翻译”。

### 8.1 与 `2026-04-12-mycli-codex-agent-runtime-mainloop-research.md` 的关系

那份文档回答的是：

`Codex 是怎么做的。`

这份文档回答的是：

`mycli 应该借鉴 Codex 的哪一部分，并先做什么。`

### 8.2 与 `2026-04-12-mycli-next-phase-architecture-roadmap.md` 的关系

路线图文档强调的是：

`先做强 turn 主链，再做大能力面。`

这份文档把这个判断进一步落成了更具体的优先级排序。

### 8.3 与 `2026-04-12-mycli-post-phase3-openspec-sequencing.md` 的关系

OpenSpec 顺序图强调的是：

`proposal 先开哪一个。`

这份文档则补充解释了：

`为什么这个顺序是对通用 agent 目标最有利的。`

---

## 9. 最终判断

如果用一句话总结：

`mycli 下一步不应该急着变得“会更多事”，而应该先变成一个更稳定、更自洽、更像真正 agent 的 runtime。`

换句话说：

- 不是先追求能力面扩张
- 而是先补齐决策层、工具协议层和桥接层

只有这样，后面无论做：

- 写代码
- 修 bug
- 写文档
- 写小说
- 做研究
- 做个人自动化

这些能力都能长在同一个系统上，而不是长成多套彼此分叉的小系统。

这才是对 Codex 最应该学的地方。
