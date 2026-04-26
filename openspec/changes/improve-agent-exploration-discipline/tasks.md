## 1. Runtime Policy

- [x] 1.1 在 `RuntimePolicy` 中增加 repository analysis 意图分类，并从通用 overview 路径中拆出独立策略
- [x] 1.2 将 README-only 证据从“足够回答”条件中移除，改为多源证据门槛与预算收口策略
- [x] 1.3 为重复失败路径、重复文档探索和预算耗尽场景补齐更细的 stop / reminder 决策

## 2. Prompt And Context

- [x] 2.1 更新 `react` prompt，要求 repository analysis 回答区分确认事实与推断判断
- [x] 2.2 更新 context/tool-result shaping，强化源码/配置证据优先级与大文件 range-read 引导

## 3. Activity Surface

- [x] 3.1 在 turn/activity 生成链路中加入 repository analysis 的结构化探索阶段语义
- [x] 3.2 更新 CLI 活动流渲染，优先展示结构化探索活动并抑制 README-only reasoning 噪音

## 4. Verification

- [x] 4.1 为 `RuntimePolicy` 增加“只读 README 不应提前收口”的单元测试
- [x] 4.2 为 prompt/context/activity 增加回归测试，覆盖仓库分析类任务的事实/推断边界
- [x] 4.3 运行 smoke case 验证“分析仓库”请求会继续读取真实源码或配置后再总结
