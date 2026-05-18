# mycli Skill 机制

> 基于 Codex 反馈重写。对齐 Claude Code / Codex 的 Agent Skills 标准。

## 1. Claude Code & Codex 做法

两家共用 Agent Skills 开放标准：

```
Layer 1 — 元数据（始终在上下文）：name + description (~100 tokens/skill)
Layer 2 — 指令体（模型自主触发）：模型调用 Skill("name") → 加载 SKILL.md body
Layer 3 — 资源文件（指令引用时读）：脚本/参考按需加载
```

**触发方式：模型自主判断，不是关键词匹配。** Skill 作为内置工具注册。模型看到系统上下文中的 skill 列表，自主决定何时调 Skill tool。

**关键：Skill 激活后是 persistent 状态。** 模型调了 Skill → runtime 加载指令体 → 重建上下文 → 同一 turn 继续让模型用 skill 完成任务。不是"读到一次 tool_result 就完了"。

## 2. mycli 当前状态

已有基础设施和两套触发路径（都需要清理）：

- `SkillRegistry`：元数据解析 + body 懒加载 ✅
- `CapabilityResolver.resolve()`：两套触发——显式 `$name` 语法（保留）+ trigger_hints 子字符串（删除）
- `RuntimeContext.active_skill`：turn 开始时解析 → 注入 `turn_context_assembler` → model 看到 "Active skill: {name}\n{body}"
- `default_tools()`：返回 `list[SchemaTool]`，不接受 `skill_registry` 参数

## 3. 修复方案

### 3.1 新增 Skill tool

注册到 `default_tools()`。执行时返回结构化 payload（skill_name, body, source_path, dependencies, status）。工具结果被 runtime 识别为 skill activation。

### 3.2 skill catalog 作为 context fragment

不塞进静态 `build_system_prompt()`。作为 request volatile context fragment（`runtime_reminders` 通道或 `TurnContextSection`），进入动态上下文。不破坏 cache 前缀。

### 3.3 runtime 识别 Skill 调用 → 激活 → 同一 turn 继续

TurnExecutor 检测到工具结果是 Skill → 提取 skill_name → 调 `CapabilityResolver` 构建 `CapabilityActivation` → 追加到当前 turn 的 `capability_activations` → 重建上下文 → 模型继续执行。

### 3.4 删除 trigger_hints 自动匹配

删除 `CapabilityResolver.resolve()` 中的 trigger_hints 扫描（lines 41-55）。保留 `_explicit_mentions` (`$name` 语法)。删除 `RuntimeContextBuilder.select_skill_metadata()`。

## 4. 文件变更

| 操作 | 文件 | 说明 |
|---|---|---|
| 新建 | `src/mycli/tools/skill.py` | SkillTool |
| 修改 | `src/mycli/tools/registry.py` | `default_tools()` 加 SkillTool |
| 新建 | `src/mycli/services/context/skill_catalog.py` | 渲染 skill catalog 为 context fragment |
| 修改 | `src/mycli/services/capabilities/resolver.py` | 删 trigger_hints 扫描 + 保留 `$name` 语法 |
| 修改 | `src/mycli/application/runtime/context/runtime_context_builder.py` | 删 `select_skill_metadata()` |
| 修改 | `src/mycli/application/runtime/turn_executor.py` | 检测 Skill tool 调用 → 激活 |
