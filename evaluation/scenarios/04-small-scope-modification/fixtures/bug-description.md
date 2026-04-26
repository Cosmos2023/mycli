# 问题描述

当前 `src/report_tool_template/` 下面这套原始源码有 bug：CLI 参数 `--output-dir` 没有生效，文件仍然会写到默认目录 `dist/`。

这次不要直接改原始目录。
请先把原始 py 文件复制到新的 `src/report_tool/` 目录，再在复制后的代码里修复问题。

## 期望行为

- 当传入 `--output-dir reports` 时，最终路径应为 `reports/<filename>`
- 原始 `src/report_tool_template/` 应保持不变
- 后续运行与测试都以复制后的 `src/report_tool/` 为准
- 不要改 CLI 参数接口
- 不要引入新依赖
