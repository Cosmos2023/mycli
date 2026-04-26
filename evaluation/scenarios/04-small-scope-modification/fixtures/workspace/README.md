# report-tool eval fixture

这个夹具里有两层目录约定：

- `src/report_tool_template/`
  - 原始坏模板
  - 不应被直接修改
- `src/report_tool/`
  - 评测任务期望 agent 复制并修复出的目标目录
  - 初始不存在

## 使用方式

```bash
python -m report_tool.cli --output-dir reports daily.txt
```

修复完成后，预期输出路径示例：

`reports/daily.txt`
