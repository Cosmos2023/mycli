# Plugin API v2

[English](../plugin-api-v2.md) | **简体中文** | [中文目录](README.md)

Plugin API v2 是 Node 运行时的本地扩展边界。每个已启用插件在独立 Node 子进程运行，通过经过验证、大小受限的 JSON-lines 协议与 mycli 通信。插件不能接收宿主服务对象、在初始化后修改注册项，或执行时导入 mycli 运行时内部模块。

<a id="package-layout"></a>

## 包目录结构

仓库插件位于 `<workspace>/.mycli/plugins/<plugin-id>/`，用户插件位于 `~/.mycli/plugins/<plugin-id>/`。

编译后的 v2 目录也可用 `mycli plugins add ./example-plugin` 安装，再通过 `plugins update|remove|enable|disable` 管理。受管理包使用不可变用户缓存快照，安装时默认启用，除非配置禁用。Codex 风格 bundle 是另一种格式，见 [plugin-codex-parity.md](plugin-codex-parity.md)。

```text
example-plugin/
  plugin.yaml
  package.json
  tsconfig.json
  src/
    index.ts
  dist/
    index.js
```

mycli 只加载编译后的 `dist/index.js` 或 `.mjs` 入口，入口必须位于插件目录内。原始 `.ts`、仅 CommonJS 的入口、绝对入口或含 `..` 的路径会被拒绝。

<a id="manifest"></a>

## 清单

```yaml
api_version: 2
id: example
name: Example Plugin
version: 1.0.0
description: Local example capabilities.
entry: dist/index.js
provides:
  tools: [lookup]
  hooks: [pre_tool_use]
  commands: [status]
requires_env: [EXAMPLE_ENDPOINT]
capabilities: [filesystem_read, network]
```

必填字段为 `api_version`、`id`、`name`、`entry`、`provides`、`requires_env` 和 `capabilities`。插件 ID 为小写，最多 64 字符。声明名称以字母开头，只包含字母、数字、`_` 或 `-`。

支持的能力：

- `filesystem_read`
- `filesystem_write`
- `network`
- `process_spawn`

能力决定宿主沙箱配置，不绕过普通工具审批。所有环境变量名必须明确声明；缺少声明变量时启动失败并返回稳定分类，不暴露值或其他继承环境项。

在用户或仓库配置中启用/禁用 ID：

```toml
[plugins]
enabled = ["example"]
disabled = []
```

插件需要主动启用，`disabled` 优先。仓库和用户插件 ID 相同时，用户候选优先，重复项仍可在诊断中看到。

<a id="typescript-entry"></a>

## TypeScript 入口

运行时在初始化阶段调用唯一导出的 `register(context)`：

```ts
import type { PluginContextV2 } from "@mycli/integrations";

export async function register(context: PluginContextV2): Promise<void> {
  context.registerTool(
    {
      name: "lookup",
      description: "Look up one local record.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async (input, signal) => {
      signal.throwIfAborted();
      return {
        success: true,
        summary: "record found",
        modelOutput: String(input.id),
        metadata: { source: "local" },
      };
    },
  );

  context.registerHook(
    { name: "guard", hookPoint: "pre_tool_use" },
    async () => ({ action: "allow" }),
  );

  context.registerCommand(
    {
      name: "status",
      description: "Return plugin status.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    async () => ({ ok: true, summary: "ready", metadata: {} }),
  );
}
```

所有运行时注册必须匹配清单。工具和命令输入 schema 必须是含 `properties` 的对象。重复 token/名称、未声明注册、迟到注册或初始化后注册都会被拒绝。

工具结果使用 `success`、`summary`、`modelOutput`、可选 `errorKind` 和有界 `metadata`。Hook 结果使用 `allow`、`deny`、`modify` 或 `error`；修改后的参数必须是有界对象。命令结果使用 `ok`、`summary`、可选且有界的 `content`、有界 `metadata` 和可选稳定 `error` 代码。

<a id="build-contract"></a>

## 构建约定

最小 ESM 构建可直接使用 TypeScript：

```json
{
  "type": "module",
  "scripts": {"build": "tsc -p tsconfig.json"},
  "devDependencies": {"typescript": "^5.9.0"}
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

启用前先构建插件。不要将 `entry` 指向源码加载器，也不要依赖 mycli 的开发依赖 `tsx`。

<a id="process-protocol"></a>

## 进程协议

每条 JSON-lines 消息包含 `version: 2`、有界 `request_id` 和一个明确类型：

```text
host -> initialize -> worker
host <- registered <- worker
host -> invoke     -> worker
host <- result     <- worker
host <- error      <- worker
host -> shutdown   -> worker
host <- shutdown_complete <- worker
```

宿主按 `backend/packages/contracts/schemas/` 中的 schema 验证所有入站和出站消息，实施单次初始化、不可变注册、行/stderr 大小限制、待处理请求数量限制、启动/调用/关闭超时、取消和进程树清理。崩溃会让该插件的待处理调用失败，不破坏父轮次或其他插件。

协议 JSON 是实现边界，不是插件作者直接使用的 API。作者实现 `register(context)`，传输消息交给提供的 Worker 引导程序。

<a id="security-and-diagnostics"></a>

## 安全与诊断

插件工具通过正常扩展审批策略请求单次批准。插件 hook 在声明的 hook 点运行，不能绕过操作前的拒绝式安全策略。插件命令无需模型 provider。

宿主诊断可暴露插件 ID、来源、生命周期状态、声明的注册名、数量和稳定失败分类，不包含环境变量值、请求头、原始 stdin/stdout/stderr、插件异常消息、堆栈、provider 数据、提示词、工具参数或文件内容。

失败使用共享 `integration.*` 错误目录。结构化宿主证据可含操作、阶段、超时、数字退出码、允许的终止信号/errno 和一次前序失败。`error_context` 是保留宿主元数据，插件返回的同名值会丢弃。没有版本 1 错误上下文支持的旧工具会话仍收到有界诊断文本。

崩溃、超时或取消后，新的调用可以启动替代 Worker，但必须注册与原先完全相同的工具、hooks、命令、描述和 schema。注册应确定性，不依赖进程局部状态跨调用存活。并发新调用共享启动。取消所有等待者或关闭运行时会停止后续分发。失败调用不会自动重放，因为副作用可能已发生。协议损坏和注册不匹配需要修正并显式重载运行时。

`/plugins` 显示实时进程状态和包能力。会话内命令路由为 `/plugin:<plugin-id>:<command> [json-args]`。

验证安装：

```bash
npm run build
mycli plugins list --json
mycli plugins inspect example --json
mycli plugins run example status --json-args '{}' --json
mycli doctor --json
```
