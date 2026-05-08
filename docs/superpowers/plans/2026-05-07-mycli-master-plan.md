# mycli Production-Grade Transformation: Master Plan

> **总计划索引**。4 个 Phase，20 个任务，覆盖从 MVP → 生产级的完整改造路径。

---

## Plan Files

| Phase | 文件 | 任务数 | 估时 | 状态 |
|---|---|---|---|---|
| P1 止血 | [2026-05-07-phase1-stop-the-bleeding.md](./2026-05-07-phase1-stop-the-bleeding.md) | 5 | 13d | 代码完成，待最终全量验证 |
| P2 架构 | [2026-05-07-phase2-core-architecture.md](./2026-05-07-phase2-core-architecture.md) | 5 | 20d | 代码完成，待最终全量验证 |
| P3 体验 | [2026-05-07-phase3-user-experience.md](./2026-05-07-phase3-user-experience.md) | 5 | 20d | 代码完成，待最终全量验证 |
| P4 差异化 | [2026-05-07-phase4-differentiation.md](./2026-05-07-phase4-differentiation.md) | 5 | 16d | 代码完成，待最终全量验证 |

**总计**：20 任务，69 人日 ≈ 14 周（单人）。如有 2 人并行可压缩到 10-11 周。

---

## 参考文档

| 文档 | 路径 |
|---|---|
| 上下文管理工程手册 | `docs/superpowers/specs/2026-05-06-agent-context-management-engineering-handbook.md` |
| 改造清单（20 项） | `docs/superpowers/specs/2026-05-07-mycli-production-roadmap.md` |
| 实现方案（分 Phase 详解） | `docs/superpowers/specs/2026-05-07-mycli-implementation-plan.md` |
| 任务拆分（依赖关系） | `docs/superpowers/specs/2026-05-07-mycli-task-breakdown.md` |

---

## 执行顺序

```
Step 1:  P1.1 (TokenCounter) + P1.2 (CacheZones)   并行
Step 2:  P1.3 (ToolResultBudget)                    依赖 P1.2
Step 3:  P1.4 (LLMSummarization)                    依赖 P1.2
Step 4:  P1.5 (消除双路径)                            依赖 P1.1-P1.3
────────────────── Phase 1 完成 ──────────────────
Step 5:  P2.1-P2.5 + P3.3 + P3.4                   6 任务并行
Step 6:  P2.3 (Budget Backpressure)                 依赖 P1.1
────────────────── Phase 2 完成 ──────────────────
Step 7:  P3.1 + P3.2 + P3.5 + P4.1                  4 任务并行 (依赖 P2.1)
Step 8:  P4.2                                        依赖 P2.1
Step 9:  P4.3                                        依赖 P3.4
Step 10: P4.4                                        依赖 P1.1 + P1.4
Step 11: P4.5                                        依赖 P1.1
```

---

## 使用方式

每个 Phase plan 都包含：
- 完整 TDD 流程（先写 failing test → 实现 → 验证 pass）
- 精确的文件路径和代码
- 每步的 git commit 命令

**建议执行方式**：使用 superpowers:subagent-driven-development，每个 task 派一个独立子 agent 执行。

**Codex 使用**：直接将每个 Phase plan 文件作为 Codex plan mode 的输入。

---

## Current Execution Notes

- 代码实现已覆盖 4 个 Phase 的主线任务；每个 Phase plan 的 commit 步骤未执行，保留 dirty worktree 供统一审查/提交。
- 记忆模块不保留向量库依赖；ChromaDB、sentence-transformers 不纳入项目依赖。Rich、pygments、structlog、tiktoken 已纳入依赖以覆盖计划中的 CLI、日志和 token 计数要求。
- 50-turn/40-tool soak 已有确定性单测入口；缓存命中率 benchmark 已有 `--min-cache-hit-rate` 阈值判定入口，真实 provider benchmark 仍需带 API key 手工执行。
- 最终状态以 `uv run ruff check src tests`、`uv run mypy src/mycli`、`uv run pytest -q tests/unit tests/integration` 为准。
