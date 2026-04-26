## ADDED Requirements

### Requirement: Repository analysis SHALL require multi-source evidence

当用户请求分析仓库用途、入口文件、主要模块或整体架构时，系统 MUST 将该 turn 视为 repository analysis，而不是通用的简略 overview。对于此类 turn，系统 MUST 在获得多源证据之前禁止因为单一说明文档或单次目录遍历而强制进入最终总结。

#### Scenario: README-only evidence is not sufficient

- **WHEN** 用户请求分析仓库，而当前成功证据只有根目录列表与 `README.md` 内容
- **THEN** 系统 MUST NOT 将该 turn 判定为“证据已足够”
- **THEN** 系统 MUST 继续引导 agent 去读取真实源码或配置文件证据，除非预算已耗尽

#### Scenario: Source-backed evidence is sufficient for a concise summary

- **WHEN** 用户请求分析仓库，且系统已经获得至少一次关键目录结构证据以及至少一份真实源码或配置文件证据
- **THEN** 系统 MAY 允许 agent 基于已确认的证据给出简短总结
- **THEN** 系统 MUST 避免无意义的继续探索，除非仍有关键事实缺失

### Requirement: Repository analysis answers SHALL distinguish confirmed facts from inference

对于 repository analysis turn，系统 MUST 约束最终回答优先基于已确认的文件证据；若回答包含尚未被源码或配置验证的判断，系统 MUST 将其表述为推断，并指出缺失的验证依据。

#### Scenario: Incomplete evidence yields bounded conclusions

- **WHEN** repository analysis turn 在预算内仍未获得足够源码或配置证据
- **THEN** 系统 MUST 允许 agent 给出基于当前证据的有限总结
- **THEN** 该总结 MUST 区分“已确认事实”和“推断判断”
- **THEN** 该总结 MUST 指出仍未验证的关键路径或文件

#### Scenario: Confirmed evidence allows direct summary

- **WHEN** repository analysis turn 已具备足够的多源证据
- **THEN** 系统 MAY 输出简洁总结而不额外展开推断免责声明
- **THEN** 该总结 MUST 仍然只陈述与已确认证据一致的结论

### Requirement: Repository analysis SHALL prefer targeted exploration primitives

对于 repository analysis turn，系统 MUST 优先引导 agent 使用结构化、可验证的探索工具路径，而不是依赖对大文档或说明文档的单点读取。

#### Scenario: Targeted exploration is preferred before broad summarization

- **WHEN** repository analysis turn 刚开始，agent 还没有形成足够证据
- **THEN** 系统 MUST 优先鼓励使用目录遍历、文本检索和范围读取等工具
- **THEN** 系统 MUST 优先鼓励读取真实源码或配置文件，而不是仅依赖说明文档

#### Scenario: Large-file exploration is redirected toward range reads

- **WHEN** agent 获取到大文件或长片段证据，且该证据不足以直接支持总结
- **THEN** 系统 MUST 引导 agent 使用范围读取或精确路径验证
- **THEN** 系统 MUST 避免反复对同一大文件进行低价值全文探索

### Requirement: Repository analysis SHALL expose structured exploration activity

对于 repository analysis turn，系统 MUST 产出用户可见的结构化活动语义，用于表示当前探索阶段与收口状态，而不是只暴露零散 reasoning 文本。

#### Scenario: Exploration stage is visible during repository inspection

- **WHEN** agent 正在做仓库结构检查、入口定位或源码验证
- **THEN** 系统 MUST 生成对应阶段的活动语义
- **THEN** CLI MUST 能据此展示 agent 当前正在做的关键事情

#### Scenario: Answer transition is visible when evidence is sufficient

- **WHEN** repository analysis turn 达到证据门槛并准备收口回答
- **THEN** 系统 MUST 生成“基于确认的证据回答”之类的收口活动语义
- **THEN** CLI MUST 优先展示该结构化活动，而不是重复 reasoning 噪音
