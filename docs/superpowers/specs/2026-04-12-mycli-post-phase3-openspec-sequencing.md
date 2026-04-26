# mycli 阶段三之后的 OpenSpec 提案顺序图

**日期：** 2026-04-12

**状态：** 提案顺序建议已收敛，可作为后续 OpenSpec change 的排期依据

**适用范围：** 承接当前 `turn 主链增强` 路线图与“向通用个人 AI assistant 演进”路线图，回答“阶段三后半段以及更长期的 change 应该按什么顺序开启”

---

## 1. 这份文档解决什么问题

当前 `mycli` 已经完成或基本完成：

- 阶段一：turn context assembly / exploration discipline
- 阶段二：capability injection
- 阶段三前半段：tool exposure / router 骨架

但如果继续往下推进，容易再次遇到一个老问题：

`大家都知道后面还要做很多事，但不知道下一版 OpenSpec change 该先开哪一个。`

这份文档的目标不是扩写一份新路线图，而是把后续 change 的优先级明确收敛成一条实际可执行的顺序。

一句话说：

`这不是“未来想做什么”的清单，而是“接下来最值得先开什么 proposal”的顺序图。`

---

## 2. 排序原则

后续 proposal 的排序，建议遵循四条原则。

### 2.1 先解决真实使用中的质量瓶颈

如果某个问题已经在 smoke、日志和实际体验中反复出现，它的优先级应高于“看起来很高级”的未来能力。

当前最典型、也最容易观察的样本例子就是：

- 代码库分析类任务容易过早收口
- 证据型任务容易搜索漂移
- 已有正确线索后仍不会及时收口

这些问题不解决，后续加 dynamic tools、MCP、更多 capability，只会放大噪音。

这里要特别强调：

- 代码库分析只是当前最强的观测样本
- 它不是 `mycli` 的长期产品定位
- proposal 排序的依据应始终是“是否改善通用 agent runtime”，而不是“是否改善仓库分析体验”

### 2.2 先补主链中的“决策层”，再补能力来源

阶段三前半段已经有了 tool exposure / router 骨架，但“如何决定搜什么、何时停、何时换路、何时回答”还不够稳。

因此：

- 决策与探索策略
  优先于
- 更多工具来源

### 2.3 先把协议稳定，再把能力面做宽

如果 dynamic tools 和 provider tools 的承载协议不稳定，那么后面新增“写作工具”“研究工具”“自动化工具”“MCP 工具”只会再次变成旁路。

### 2.4 先做 runtime 受益最大的抽象

优先做那种一旦落地，就能同时改善：

- coding
- codebase analysis
- debugging
- writing / research
- future assistant tasks

而不是只对单一场景有收益的优化。

---

## 3. 当前已完成与未完成的边界

为了避免 proposal 顺序判断混乱，需要先明确“哪些事已经做过，哪些只是有骨架”。

### 3.1 已经基本站稳的部分

- `improve-agent-exploration-discipline`
- `add-turn-context-assembly`
- `productize-capability-injection`
- `add-tool-exposure-router`

这些 change 让 `mycli` 已经具备：

- turn context assembly
- capability injection
- tool exposure / router 骨架
- tool exposure 的 context / trace / turn item 可见性

### 3.2 仍然明显不稳的部分

当前仍然没有真正稳定下来的，是：

1. **探索策略层**
   - 查询词重写
   - 搜索范围选择
   - 截断后的继续读取策略
   - enough evidence 的收口判断

2. **dynamic tools 正式协议层**
   - 现在还是第一版 hook
   - 缺少稳定 descriptor / lifecycle / conflict handling

3. **provider / MCP bridge**
   - 现在只有 namespace 预留，没有实际桥接

4. **更高层的多任务 capability 产品化**
   - 还没有把 coding / debugging / writing / research 等任务类型正式产品化为 capability / workflow

---

## 4. 建议的后续 proposal 顺序

如果以“阶段三后半段到通用 assistant 的主线”来看，建议后续按下面顺序开 proposal。

## 4.1 第一优先级：`stabilize-agent-runtime-decision-policy`

这是后续最值得先开的 change。

### 为什么它必须先做

因为现在最大的真实瓶颈已经不再是“有没有 tool exposure”，而是：

- agent 仍会被错误搜索结果带偏
- 对实现验收类问题不会稳定沿源码主路径探索
- 拿到 enough evidence 后仍不会及时回答
- 容易重复读取同一文件直到被 runtime policy 打断

这是所有高阶能力的前置问题。

如果这层不稳：

- dynamic tools 会被乱用
- MCP 工具会被放大成更多噪音
- writing / research capability 也会出现类似的“收口失控”

### 这版 proposal 应解决什么

- 不同任务类型的 runtime decision policy 分层
  - codebase analysis
  - implementation audit
  - debugging
  - research / writing
- 搜索词重写与源码主路径优先
- 日志 / model-raw / docs 噪音的降权规则
- enough evidence 的正式判定
- 重复读取同一文件前的换路或收口机制
- `read_file` 截断后优先切换 `read_file_range`

### 为什么它排第一

因为这是“让通用 agent runtime 更稳定”的质量主线，而不是功能主线。

---

## 4.2 第二优先级：`formalize-dynamic-tool-contract`

在探索策略稳定后，下一步应把 dynamic tools 从“可用入口”升级成“稳定协议”。

### 为什么它排第二

阶段三前半段已经完成了：

- `ToolExposurePlanner`
- `ToolRouter`
- direct / deferred / dynamic 分类

但 dynamic tools 目前仍然更像内部 hook，而不是正式 runtime 对象。

如果不先把这层做稳，后面：

- capability-contributed tools
- provider tools
- future assistant tasks 的专用工具

都很难统一进主链。

### 这版 proposal 应解决什么

- dynamic tool descriptor
- runtime-generated tool 与 capability-contributed tool 的统一声明模型
- turn / thread scoped lifecycle
- 去重、冲突处理、优先级
- dynamic tool 的 context / trace / surface 可见性
- 从 hook 式接入升级为协议式接入

### 为什么它排在探索策略之后

因为没有稳定的 runtime decision policy，协议越强，误用成本越大。

---

## 4.3 第三优先级：`add-provider-tool-bridge`

当本地工具主链和 dynamic tool 协议都稳定后，再接 provider / MCP / hosted tools。

### 为什么它排第三

因为 provider tools 不是当前最大的质量瓶颈，而是当前最大的复杂度放大器。

如果现在就接：

- 会把本来就不稳的探索决策进一步放大
- 会让 provider 差异重新进入 CLI 与 runtime 主链

只有在：

- exploration policy 稳
- dynamic tool protocol 稳

之后，provider bridge 才会真正成为能力扩展，而不是复杂度扩展。

### 这版 proposal 应解决什么

- namespaced provider route 的正式桥接
- hosted/provider-specific item lifecycle
- provider descriptor 到 router 的映射
- provider tool trace / error / metadata 归一化
- MCP 的最小稳定挂点

---

## 4.4 第四优先级：`productize-multi-task-capabilities`

前三个阶段解决的是“runtime 能不能稳”；到了这里，才值得正式推进“多任务 assistant”能力。

### 为什么它不应更早做

因为“写代码”“写小说”“做研究”“修 bug”这些能力，真正难的不是 prompt，而是：

- 怎么接入 turn
- 怎么选择工具面
- 怎么定义验证与收口策略

这些都依赖前面的主链已经稳定。

### 这版 proposal 应解决什么

- 把任务类型产品化为正式 capability / workflow
- coding / debugging / writing / research / automation 的运行时差异建模
- capability 与 tool exposure 的联动增强
- capability 与记忆 / 风格 /长期偏好的协作

### 它的战略意义

这是 `mycli` 从“偏 coding agent”走向“通用个人 assistant”的真正拐点。

---

## 4.5 第五优先级：`productize-surface-state-protocol`

当 runtime 和能力面都更稳后，再推进多 surface 的一致状态协议。

### 为什么它排第五

因为 surface 是主链消费者。

如果前面的 runtime / capability / router / provider bridge 还不稳，越早做 surface，越容易让 UI 反向定义系统边界。

### 这版 proposal 应解决什么

- 更完整的 commentary / final / tool lifecycle item
- CLI / IDE / Web 可共享的 turn state
- approval waiting / context update / capability activation / tool exposure / provider items 的统一展示协议
- 为 multi-agent 与 long-running session 做状态协议准备

---

## 5. 这条 proposal 顺序背后的主线

如果把这些 proposal 压缩成一句话，它的推进逻辑其实很简单：

1. **先稳 agent 怎么探索**
2. **再稳 agent 怎么接入更多工具**
3. **再稳 agent 怎么接入外部工具生态**
4. **再稳 agent 怎么切换不同任务身份**
5. **最后再让多个 surface 消费统一状态**

换句话说：

`先稳决策，再稳协议，再扩能力，再扩宿主。`

---

## 6. 对当前阶段最实际的建议

如果你只想知道“下一版到底该先开什么 change”，结论很明确：

### 6.1 立即建议开启的 change

`stabilize-agent-runtime-decision-policy`

这是当前最能改善真实使用质量的一版 proposal。

### 6.2 紧随其后的 change

`formalize-dynamic-tool-contract`

这会把阶段三从“有骨架”推进到“有稳定协议”。

### 6.3 暂时不要抢跑的 change

- provider / MCP 真接入
- 多任务 capability 大扩展
- 多 surface / multi-agent 深化

这些都应该在前两项之后再做。

---

## 7. 最终判断

`mycli` 现在最需要的，不是立刻变成“功能很多的 assistant”，而是继续沿着统一主链，把阶段三后半段真正打稳。`

因此，后续 OpenSpec change 最合理的顺序不是“哪个听起来更酷先做哪个”，而应该是：

1. `stabilize-agent-runtime-decision-policy`
2. `formalize-dynamic-tool-contract`
3. `add-provider-tool-bridge`
4. `productize-multi-task-capabilities`
5. `productize-surface-state-protocol`

一句话收尾：

`对 mycli 来说，真正接近通用个人 AI assistant 的路径，不是更快地长更多功能，而是按顺序把“探索决策、工具协议、外部桥接、任务能力、surface 状态”这五层逐层做稳。`
