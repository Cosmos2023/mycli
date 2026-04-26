## 1. Exploration Policy Runtime Model

- [x] 1.1 为 runtime stabilization 的策略层定义 decision profile 与 policy signals，而不是强 task classification
- [x] 1.2 扩展 runtime policy decision / trace / activity 所需的策略状态字段
- [x] 1.3 为 enough-evidence、noise deprioritization 和 truncation-routing 建立可测试的决策入口

## 2. Source-First And Query Routing

- [x] 2.1 在 runtime policy 中加入源码 / 配置主路径优先规则，降低 `log/`、`model-raw/`、无关 docs 的默认权重
- [x] 2.2 为实现验收类请求增加更明确的查询词重写与源码接入点优先策略
- [x] 2.3 让 `read_file` 截断提示能够驱动后续优先切换到 `read_file_range`

## 3. Sufficiency And Repeated Exploration Control

- [x] 3.1 为不同 decision profile 建立 profile-specific sufficiency 判定
- [x] 3.2 在 repeated exploration 上增加“提醒换路 / 建议收口 / 最终 loop stop”的分层策略
- [x] 3.3 避免 agent 在已拿到关键证据后仍继续重复读取同一路径

## 4. Context, Prompt, And Surface Integration

- [x] 4.1 更新 turn context / runtime reminders，使 exploration policy 的当前 decision profile 与约束正式可见
- [x] 4.2 更新 `react` prompt，使模型收到更明确的 source-first、noise-deprioritization 与收口契约
- [x] 4.3 更新 activity / trace 渲染，让策略状态和“evidence 已足够”的转变可见

## 5. Verification

- [x] 5.1 增加 focused 单元测试，覆盖 change 名误导搜索、日志噪音降权、截断后 range-read、以及 repeated exploration 换路
- [x] 5.2 增加 integration / runtime smoke，覆盖 codebase analysis、implementation audit 与 debugging 三类高信号样本任务
- [x] 5.3 运行相关测试与 smoke，验证 agent 在通用证据型任务中更少漂移、更早收口、且不再轻易因重复读取同一文件而失败
