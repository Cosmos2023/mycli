# 场景 04 Fixtures

## 建议文件

- `workspace/`
  - 一个小型项目目录
- `bug-description.md`
- `verify.sh` 或 `pytest` 用例
- `expected-diff-notes.md`
  - 可选
  - 记录允许改动范围

## 素材约束

- 问题应可复现且改动范围小
- 应有明确“不要改 CLI 接口”的边界
- 应有明确“先复制模板、再修复制品”的边界
- 最好能通过一条测试或 smoke 命令验证

## 后续可补

- `allowed-files.txt`
- `expected-check-results.json`
