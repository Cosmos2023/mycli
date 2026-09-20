<a id="provider-support"></a>

# Provider 支持

[English](../providers.md) | **简体中文** | [中文目录](README.md)

mycli 使用两个工作区清单中精确固定的 `@earendil-works/pi-ai` 版本所提供的 provider 和模型目录。Dependabot 每日检查新版，并通过经过测试的 pull request 更新清单和根锁文件。稳定产品路由和下文三个 Qwen Token Plan 目录路由默认启用；其他目录路由只有明确声明后才启用，因此升级 pi-ai 不会静默激活新网络目的地址。已启用路由中的新模型会在依赖更新通过后可用。凭据仍由 mycli 管理，来源为 `MYCLI_API_KEY` 或私有 `~/.mycli/auth.json`。受支持的原生路由还可以通过 mycli 凭据适配器使用 provider 环境认证和 OAuth。

启动和恢复会话只读取登录元数据，不加载完整 pi-ai 目录。原生凭据检查在本地加载所需认证适配器，不刷新 OAuth 或发起模型请求。打开 `/model` 时发现完整目录；执行轮次前会记录所选路由和模型元数据。

路由支持级别分为三类：

- `stable`：产品正式支持、默认值向后兼容的路由。
- `experimental`：由产品或用户声明启用的 pi-ai 目录路由。目录元数据具有权威性，但没有验证记录就不能宣称真实服务已受验证。
- `compatible`：明确声明、端点或模型不由 pi-ai 提供的路由。

<a id="curated-pi-ai-profiles"></a>

## 精选 Pi-AI 配置

以下 API Key 服务是直接支持的 Chat Completions 配置。默认值固定在 mycli 中，并根据工作区固定版本的 pi-ai 验证。

| Provider | ID | 默认模型 | 默认基础 URL | 默认推理强度 |
| --- | --- | --- | --- | --- |
| OpenRouter | `openrouter` | `openrouter/auto` | `https://openrouter.ai/api/v1` | `medium` |
| Groq | `groq` | `openai/gpt-oss-120b` | `https://api.groq.com/openai/v1` | `medium` |
| Together | `together` | `moonshotai/Kimi-K2.7-Code` | `https://api.together.ai/v1` | `high` |
| Moonshot AI | `moonshotai` | `kimi-k2.7-code` | `https://api.moonshot.ai/v1` | `high` |
| NVIDIA | `nvidia` | `openai/gpt-oss-120b` | `https://integrate.api.nvidia.com/v1` | 禁用 |
| Cerebras | `cerebras` | `gpt-oss-120b` | `https://api.cerebras.ai/v1` | `medium` |

Setup 写入模型专属推理默认值，避免首次执行继承不兼容的全局强度。不在编译目录中的自定义模型默认关闭推理。

六个配置均支持确定性的基础能力：流式文本、工具、用量、标准 provider 状态、重放验证，以及由 mycli 管理的重试。传给 pi-ai 的 `maxRetries: 0` 禁用其重试；全局和各 provider 的请求/流重试预算由运行时管理。

已知模型使用 pi-ai 固定的角色、token 字段、严格工具、缓存、存储、推理和输入元数据。mycli 不在 provider 配置中重复维护这些传输事实。目录之外的模型必须明确声明图片、推理等语义元数据；传输格式由 pi-ai 自动检测和可选、经过验证的 `compat` 覆盖管理。托管网络搜索仍是 mycli 独立提供、仅用于 Responses 的能力。

托管搜索和助手文本共用有上限的流队列。消费者较慢时，上游交付暂停；队列最多保留 64 个事件和 8 MiB 序列化 UTF-8 数据。超限会报告 `response_stream_error` 并说明缓冲限制。取消轮次或停止消费会释放待处理流读取。

请求缓存统一使用 `request.cache_retention = "none" | "short" | "long"`，默认 `short`。mycli 将偏好和稳定会话 ID 传给 pi-ai，由其映射到 provider 专有字段，最终是否保存或命中缓存由 provider 决定，因此该设置不保证缓存命中。

<a id="retry-budgets"></a>

## 重试预算

全局默认仍是四次请求重试和五次流重试。每个 provider 路由可在 `config.toml` 中独立覆盖任一预算：

```toml
[request]
request_max_retries = 4
stream_max_retries = 5

[request.request_max_retries_by_provider]
openai = 2
private-relay = 0

[request.stream_max_retries_by_provider]
openai = 3
private-relay = 0
```

键表示 mycli provider 路由（包括声明的路由），不是模型名或上游目录标识。每张表最多 128 个路由，值为 0 到 100 的整数。未列出的路由使用对应的最终全局设置，包括环境变量覆盖。最高优先级且包含该表的文件层会替换整张表；空表清除低层覆盖。只有受信任工作区的项目表参与配置。`config show` 和 `config get` 显示表及来源；`config set` 或 `config unset` 不能修改结构化表。

有效预算在 provider 步骤发起时与已提交请求标识一同复制。退避期间修改配置不影响该步骤。请求和流计数跨步骤内所有尝试保留，因此最多发起 `1 + request retries + stream retries` 次请求。输出开始前，符合条件的请求失败先使用请求预算，然后可使用流预算。流恢复会丢弃未完成输出。两个预算都为零即禁用重试。认证、权限、配额、无效请求和上下文溢出始终终止这个重试循环，不受预算影响。

Retry-After 只改变可取消的等待时间，上限一小时，不增加预算。没有 Retry-After 时，使用带随机抖动的指数退避，基础延迟从 200 ms 增长到 4 秒。退避时取消会在下一请求前停止恢复。上下文压缩是独立恢复操作，明确提交新的逻辑请求并开始自己的预算；普通重试保持相同 provider、模型和请求，不重放已提交工具。

<a id="setup-and-credentials"></a>

## 设置与凭据

交互设置列出所有直接支持的配置：

```bash
mycli setup
```

自动化时通过 stdin 传入 API Key。下例假设 Shell 变量已经设置，且不打印其值：

```bash
printf '%s\n' "$GROQ_API_KEY" | \
  mycli setup --non-interactive --provider groq --with-api-key --json
```

使用 `--model` 和 `--base-url`，可在保留正式 provider 标识的同时指定模型或端点：

```bash
printf '%s\n' "$OPENROUTER_API_KEY" | \
  mycli setup --non-interactive --provider openrouter \
  --model openrouter/auto --base-url https://openrouter.ai/api/v1 \
  --with-api-key --json
```

示例通过 setup stdin 传入 provider 专有变量，并将密钥保存在 mycli 选定的 `auth_ref` 下。`MYCLI_API_KEY` 和存储的凭据仍是显式认证来源。允许环境认证时，受支持的原生路由也能解析其专属环境变量；自定义声明路由不会自动继承原生 provider 的凭据链。

`mycli login --oauth --provider <provider-id>` 为受支持原生 provider 启动 OAuth。OAuth 凭据和刷新结果使用 mycli 私有认证存储。`mycli login status` 报告所选凭据来源；`mycli logout` 删除本地存储凭据，不清除环境凭据。另见[认证命令](commands.md#provider-free-cli-commands)。

<a id="provider-scoped-model-selection"></a>

## 按 Provider 选择模型

`/model` 加载 provider 目录，解析当前路由并直接打开其模型列表。Enter 将高亮模型及默认推理设置应用到当前会话；Tab 可选择推理强度，以及仅作用于当前会话还是保存为用户默认值。用 `[` 和 `]` 在已启用 provider 间切换，无需离开模型列表。存在多个路由时，Esc 打开可搜索 provider 列表。

无法解析当前路由时，先打开 provider 列表。缺少存储凭据的路由仍可见，并在加载模型目录前打开隐藏输入的登录流程。只有一个已启用路由时跳过 provider 列表。

`/model <name>` 只搜索当前 provider，不会切换到拥有同名模型的其他 provider。切换路由应使用 `[`/`]` 或 provider 列表。修改会话或用户默认值前，模型选择会按路由、协议、模型 ID 和规范化端点验证。

<a id="pi-ai-qwen-catalogs"></a>

### Pi-AI Qwen 目录

以下 pi-ai Qwen 路由无需在 `models.json` 声明，即可在 `/model` 中使用：

| Provider | 路由 ID | pi-ai 0.84.4 中的模型数 |
| --- | --- | --- |
| Qwen Token Plan | `qwen-token-plan` | 18 |
| Qwen Token Plan CN | `qwen-token-plan-cn` | 18 |
| Qwen Token Plan Individual | `qwen-token-plan-individual` | 8 |

打开 `/model`，按 Esc 进入 provider 列表并选择对应 Qwen Token Plan 路由。缺少 API Key 时首次选择会打开登录流程。完整的匹配协议 pi-ai 目录提供模型 ID、推理级别、图片支持、token 上限和端点。这些路由仍为 `experimental`；启用目录不代表账号已经能够访问所有模型。

每个路由默认使用独立凭据引用。已有 v2 声明可以覆盖凭据引用、端点或模型元数据；只有 `model_policy: "subset"` 才限制目录。加载目录不会写入 `models.json`，新模型跟随 pi-ai 依赖更新。

原有 `qwen` 路由仍是普通 DashScope，保留原端点、凭据和兜底模型。Token Plan 路由使用 SDK 的独立端点，不自动复用普通 DashScope 凭据。

<a id="experimental-catalog-routes"></a>

## 实验性目录路由

在 `~/.mycli/models.json` 中启用额外 API Key 路由。基于目录的路由默认使用固定版本 pi-ai 目录中所选协议的所有模型。`models` 对象用于覆盖匹配的目录元数据或显式新增目录外模型，不会成为隐式允许列表：

```json
{
  "version": 2,
  "providers": {
    "fireworks": {
      "source": "pi_ai_builtin",
      "protocol": "chat_completions",
      "auth_ref": "fireworks-primary"
    }
  }
}
```

重启 mycli，运行 `/model`，选择 `fireworks` 并在登录流程输入密钥。密钥保存在 `fireworks-primary` 下，不写入 `models.json` 或 `config.toml`。

要有意只暴露指定目录模型，明确启用子集策略：

```json
{
  "version": 2,
  "providers": {
    "deepseek": {
      "protocol": "chat_completions",
      "model_policy": "subset",
      "models": {
        "deepseek-v4-flash": {},
        "deepseek-v4-pro": {}
      }
    }
  }
}
```

不设置 `model_policy: "subset"` 时，后续 pi-ai 更新可以让新收录的 DeepSeek 模型出现在 `/model`，无需重写文件。已有旧式扁平目录保留原来的显式子集行为。

某个 pi-ai provider 如果暴露多个受支持协议或要求端点，就需要明确的路由别名，以将一个协议和端点绑定到一个路由标识：

```json
{
  "version": 2,
  "providers": {
    "cloudflare-chat": {
      "catalog_provider": "cloudflare-ai-gateway",
      "protocol": "chat_completions",
      "base_url": "https://gateway.example/v1/account/gateway",
      "auth_ref": "cloudflare-chat"
    }
  }
}
```

不支持的 pi-ai 协议、不使用 API Key 认证的 provider 和空目录仍为 `unserviceable`。仅保存密钥不会启用路由。

### 原生 OpenAI Responses

pi-ai 的 `openai` provider 只提供 Responses（`openAIChatCompletions` 不适用于它）。想让请求走原生传输而不是 mycli 内置客户端，需要显式声明一条路由：

```json
{
  "version": 2,
  "providers": {
    "openai": {
      "source": "pi_ai_builtin",
      "catalog_provider": "openai",
      "protocol": "responses",
      "base_url": "https://gateway.example/v1"
    }
  }
}
```

- `protocol` 必须是 `responses`。把它配成 `chat_completions` 会在启动前失败并报 `native model API does not match configured protocol`。
- 不写 `base_url` 就用 pi-ai 的默认值（`https://api.openai.com/v1`）。对于当前选中的路由，`config.toml` 的 `[model] api_base_url` 或 `MYCLI_BASE_URL` 优先于声明里的 `base_url`，后者优先于 pi-ai 默认值。端点必须是绝对的 `http`/`https` URL，不能带凭据、query 或 fragment。
- 不在 pi-ai 目录里的模型需要显式 `model_policy: "subset"` 并在 `models` 中列出，否则会报 `native provider model or API is unsupported`。
- 启用环境认证时，pi-ai 的 OpenAI provider 读取 `OPENAI_API_KEY`。mycli 自己的凭据仍然有效：`mycli login --with-api-key --provider openai` 会把密钥写在该路由的 `auth_ref` 下，`MYCLI_API_KEY` 也仍是显式来源。

同样的写法适用于其它 Responses provider：`openai-codex` 对应 Codex 后端，`azure-openai-responses` 配合 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`、`AZURE_OPENAI_API_VERSION` 以及可选的 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。

<a id="compatible-endpoints"></a>

## 兼容端点

不在正式支持列表中的 OpenAI 兼容服务使用 `compatible`，并明确配置协议、端点、模型和凭据：

```toml
[model]
provider = "compatible"
protocol = "chat_completions"
name = "custom-code-model"
api_base_url = "https://provider.example/v1"
auth_ref = "compatible"
supports_images = false

[request]
cache_retention = "none"

[reasoning]
enabled = false
reasoning_effort = "none"
```

`compatible` 提供通用 OpenAI 兼容行为，不表示 mycli 已验证该服务的认证、模型目录、推理方言、重放细节或可选控制。原生路由独立存在：当前协议映射包括 OpenAI Chat Completions、Responses、Anthropic Messages 和 Azure Responses。Google、Vertex、Bedrock、Mistral 专有协议不会仅因为 pi-ai 中存在相应模块而启用。认证支持也取决于所选原生 provider；兼容端点不会继承其 OAuth 或云凭据。

要使用具名自定义路由而不是共用的 `compatible` 配置，在 `models.json` 中声明完整路由和模型元数据：

```json
{
  "version": 2,
  "providers": {
    "private-gateway": {
      "source": "pi_ai_declared",
      "protocol": "chat_completions",
      "base_url": "https://gateway.example/v1",
      "auth_ref": "private-gateway",
      "capabilities": { "images": false },
      "compat": {
        "supportsDeveloperRole": false,
        "supportsStore": false,
        "maxTokensField": "max_tokens"
      },
      "models": {
        "private-code-model": {
          "limits": {
            "context_window_tokens": 64000,
            "max_output_tokens": 8192
          },
          "compat": { "supportsDeveloperRole": true }
        }
      }
    }
  }
}
```

只有私有中转与 pi-ai 目录元数据或自动检测结果不同时才使用 `compat`。发起流量前按所选 API 验证值。模型值覆盖路由值，路由值覆盖 pi-ai 默认值。未知键、无效值和其他 API 字段会以信息受限的配置错误失败。这是传输事实的覆盖入口，不是产品能力声明位置；图片、推理选项、限制和托管搜索仍应放在已有模型声明字段中。

mycli 继续负责 API Key 查找、基础 URL 路由、模型选择、会话状态和可观测重试。Pi-ai 负责 developer/system 角色选择、缓存与存储字段、推理方言、输出 token 字段名、严格工具行为和会话亲和请求头。mycli 仅保留一个请求体 hook：为实时 Responses 搜索插入原生 `web_search` 工具。

原生搜索在 TUI 中运行时显示 `Searching the web`，完成时显示 `Searched the web for ...`。mycli 在 pi-ai 助手事件之外观察这些活动；它们不是本地函数调用。成功 provider 步骤中的已完成搜索会保存到会话历史。多个查询保留大小受限的元数据，精简行显示首个查询及省略号。Provider 重试时会移除失败尝试的搜索记录。

<a id="rollback"></a>

## 回退

旧 mycli 版本不识别六个新 provider ID。降级前，将活动配置转换为 `compatible`，保留 `chat_completions`、端点、模型和 `auth_ref`。例如 Groq 回退配置：

```toml
[model]
provider = "compatible"
protocol = "chat_completions"
name = "openai/gpt-oss-120b"
api_base_url = "https://api.groq.com/openai/v1"
auth_ref = "groq"
supports_images = false
```

实验路由也使用相同转换方式，但先将准确协议、端点、模型和 `auth_ref` 复制到 `compatible` 配置。这不会重写凭据或对话。更换包版本前备份 `~/.mycli`，不要让两个版本同时访问同一会话数据库。

<a id="opt-in-live-verification"></a>

## 主动启用真实服务验证

普通测试套件使用模拟 HTTP 传输，不需要外部凭据。要无流量地检查已保存凭据：

```bash
npm run smoke:providers -- --dry-run
```

测试所有默认私有凭据引用下已有密钥的精选 provider：

```bash
npm run smoke:providers -- --evidence release-evidence/providers-live.json
```

使用仅本次启动有效的密钥测试单个 provider，而不是使用存储凭据：

```bash
MYCLI_API_KEY="$GROQ_API_KEY" \
  npm run smoke:providers -- --provider groq \
  --evidence release-evidence/groq-live.json
```

运行器发送一个固定、无敏感信息、不含工具的提示词，适配器不重试。通过要求包括标准文本、用量、匹配的 provider 状态和恰好一次完成。输出和可选的 `0600` 权限证据只含 provider/模型标识、凭据来源、结构性布尔值和大小受限错误码。缺失凭据标记为 `skipped`，退出码为 `77`；provider 失败不会改标为跳过。只有记录行是 `passed` 时，才能称该 provider 经过真实服务验证。
