<a id="migrating-python-plugins-to-plugin-api-v2"></a>

# 将 Python 插件迁移到 Plugin API v2

[English](../../migration/python-plugins-to-v2.md) | **简体中文** | [中文目录](../README.md)

M8 不导入或执行 Python 插件源码。含有 `__init__.py`，或清单缺少 `api_version: 2` 的旧插件会报告 `migration_required`。Doctor 只报告状态，不重写文件或执行转换代码。

<a id="mapping"></a>

## 对应关系

| 旧 Python 插件 | Plugin API v2 |
| --- | --- |
| 没有 API 版本的 `plugin.yaml` | `api_version: 2` 和明确声明 |
| 含 `register(ctx)` 的 `__init__.py` | 导出 `register(context)` 的编译 ESM 入口 |
| 进程内模块 | 隔离的 Node Worker 进程 |
| 隐式宿主导入 | `registerTool`、`registerHook`、`registerCommand` 门面 |
| 任意环境变量访问 | 在 `requires_env` 中明确列出的变量名 |
| 隐式文件/网络/进程访问 | 声明的能力与宿主沙箱策略 |
| 向宿主返回 traceback | 稳定、有界的失败分类 |
| 可变注册 | 一次不可变初始化阶段 |

<a id="migration-steps"></a>

## 迁移步骤

1. 盘点旧插件的工具、hook 点、无需 provider 的命令、状态和环境变量名。
2. 分配小写插件 ID 和长度受限的声明名称。
3. 创建 TypeScript ESM 项目并编译到 `dist/`。
4. 仅通过 Plugin API v2 门面实现 `register(context)`。
5. 将每个输入契约转为对象 JSON Schema，明确 `required` 和 `additionalProperties` 行为。
6. 将工具、hook 和命令结果转为有界 v2 结果结构。
7. 在 `plugin.yaml` 中声明全部注册项、环境变量名和能力。
8. 在 `[plugins]` 中启用 ID，再执行 list、inspect、command 和 doctor 检查。
9. Node 行为验证通过后，将旧源码归档到活动插件发现范围之外。

起始清单：

```yaml
api_version: 2
id: migrated-example
name: Migrated Example
entry: dist/index.js
provides:
  tools: [lookup]
  hooks: [post_tool_use]
  commands: [status]
requires_env: []
capabilities: [filesystem_read]
```

起始入口：

```ts
import type { PluginContextV2 } from "@mycli/integrations";

export function register(context: PluginContextV2): void {
  context.registerTool(
    {
      name: "lookup",
      description: "Look up one record.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (input) => ({
      success: true,
      summary: "lookup complete",
      modelOutput: String(input.id),
      metadata: {},
    }),
  );

  context.registerHook(
    { name: "audit", hookPoint: "post_tool_use" },
    async () => ({ action: "allow" }),
  );

  context.registerCommand(
    {
      name: "status",
      description: "Return migration status.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => ({ ok: true, summary: "ready", metadata: {} }),
  );
}
```

<a id="behavior-differences"></a>

## 行为差异

- 注册项必须匹配清单；不匹配会导致启动失败，不暴露部分插件。
- 工具名使用稳定且适合 provider 的路由，不依赖旧模块名。
- 工具执行遵循正常扩展审批，hook 和命令不能自行授予更高权限。
- 处理器接收 abort signal，取消时应及时停止。
- 输出有上限；大型产物存入已批准位置，并返回简短引用。
- Worker 全局变量不是持久状态，需要时通过插件拥有的已批准路径保存。
- 插件命令只能新增，不能覆盖内置 slash 命令或别名。

<a id="verification"></a>

## 验证

```bash
npm run build
npm run mycli -- plugins list --json
npm run mycli -- plugins inspect migrated-example --json
npm run mycli -- plugins run migrated-example status --json-args '{}' --json
npm run mycli -- doctor
```

插件报告 `loaded`、全部运行时注册匹配清单、命令成功，且 doctor 不再将该 ID 报告为 `migration_required` 时，迁移就绪。

<a id="rollback"></a>

## 回退

M8 npm CLI 不包含 Python 后端，因此将 `__init__.py` 放在 v2 插件旁边不是可执行的 Node 回退。请通过版本控制或发现范围外的归档保留旧源码，供独立启动的 Python 运行时使用。

回退整个产品前，完成或中断活动工作，停止拥有的子进程，备份 `~/.mycli`，再安装先前 mycli 包版本。不要让新旧版本同时访问同一活动会话数据库。
