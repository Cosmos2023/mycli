<a id="configuration-reference"></a>

# 配置参考

[English](../../reference/configuration.md) | **简体中文** | [中文目录](../README.md)

> 本页译自自动生成的英文配置参考。配置键、类型、默认值和别名与原文一致；更新设置后应先重新生成英文参考，再同步译文。

参考版本：1

配置优先级从高到低为：会话、环境变量、受信任项目、所选 profile、用户、系统、旧用户配置、内置默认值。凭据应保存在 `~/.mycli/auth.json` 或进程环境中，不能作为这里的配置设置。

| 配置键 | 类型 | 默认值 | 可写 | 标准 TOML 路径 | 说明 |
| --- | --- | --- | :---: | --- | --- |
| `context.compaction_l4_buffer_tokens` | `integer` | `13000` | 是 | `context.compaction_l4_buffer_tokens` | 判断是否自动压缩时，保留这些提示词 token 作为空闲容量。 |
| `context.compaction_l4_carry_cost_per_1k` | `number` | `0` | 是 | `context.compaction_l4_carry_cost_per_1k` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_l4_carry_turns` | `integer` | `1` | 是 | `context.compaction_l4_carry_turns` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_l4_expected_summary_tokens` | `integer` | `500` | 是 | `context.compaction_l4_expected_summary_tokens` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_l4_input_cost_per_1k` | `number` | `0` | 是 | `context.compaction_l4_input_cost_per_1k` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_l4_min_savings_ratio` | `number` | `unset` | 是 | `context.compaction_l4_min_savings_ratio` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_l4_output_cost_per_1k` | `number` | `0` | 是 | `context.compaction_l4_output_cost_per_1k` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_l4_summarizer_model` | `string` | `unset` | 是 | `context.compaction_l4_summarizer_model` | 可选：为压缩摘要指定不同模型。 |
| `context.compaction_l4_trigger_ratio` | `number` | `0.9` | 是 | `context.compaction_l4_trigger_ratio` | 估算提示词用量达到当前上下文窗口的这一比例时，启动自动压缩。 |
| `context.compaction_l4_trigger_ratios_by_model` | `number_map` | `{}` | 否 | `context.compaction_l4_trigger_ratios_by_model` | 显示各模型的压缩触发比例覆盖；config 命令只能读取此结构化设置。 |
| `context.compaction_rehydration_file_max_item_tokens` | `integer` | `5000` | 是 | `context.compaction_rehydration_file_max_item_tokens` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_rehydration_file_max_total_tokens` | `integer` | `50000` | 是 | `context.compaction_rehydration_file_max_total_tokens` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_rehydration_max_files` | `integer` | `5` | 是 | `context.compaction_rehydration_max_files` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_reserved_output_tokens` | `integer` | `13000` | 是 | `context.compaction_reserved_output_tokens` | 计算压缩预算时，为下一次模型响应预留上下文容量。 |
| `context.compaction_tail_max_tokens` | `integer` | `20000` | 是 | `context.compaction_tail_max_tokens` | 限制压缩后保留的用户消息文本（默认 20000 token）；边界消息截断时附带标记。 |
| `context.compaction_tail_turns` | `integer` | `2` | 是 | `context.compaction_tail_turns` | 旧版兼容设置；本地上下文压缩不再使用。 |
| `context.compaction_token_limit` | `integer` | `9600` | 是 | `context.compaction_token_limit` | 设置用于触发压缩的提示词 token 上限。 |
| `context.compression_threshold_tokens` | `integer` | `8000` | 是 | `context.compression_threshold_tokens` | 设置在重放前压缩超大工具结果的大小阈值。 |
| `features.request_permissions_tool` | `boolean` | `false` | 是 | `features.request_permissions_tool` | 当前运行时支持时，暴露结构化权限请求工具。 |
| `memory.enabled` | `boolean` | `false` | 是 | `memory.enabled` | 为当前 Agent 运行时启用持久记忆发现和注入。 |
| `model.api_base_url` | `string` | `"https://api.openai.com/v1"` | 是 | `model.api_base_url` | 设置配置的 provider 使用的 HTTP(S) API 端点。 |
| `model.auth_ref` | `string` | `"openai"` | 是 | `model.auth_ref` | 选择凭据存储引用，不将凭据放入 TOML。 |
| `model.name` | `string` | `"gpt-5.5"` | 是 | `model.name` | 选择新运行时请求使用的 provider 模型。 |
| `model.protocol` | `string` | `"responses"` | 是 | `model.protocol` | 选择模型请求使用的 provider 传输协议。 |
| `model.provider` | `string` | `"openai"` | 是 | `model.provider` | 选择稳定配置或明确配置的 provider 路由。 |
| `model.supports_images` | `boolean` | `false` | 是 | `model.supports_images` | 覆盖所选兼容端点是否接受图片输入。 |
| `model.web_search_mode` | `string` | `"live"` | 否 | `model.web_search_mode` | 显示根据 provider 能力确定的网络搜索模式；此设置只读。 |
| `reasoning.effort` | `string` | `"medium"` | 是 | `reasoning.effort` | 为支持推理强度控制的模型选择请求强度。 |
| `reasoning.enabled` | `boolean` | `true` | 是 | `reasoning.enabled` | 为提供推理能力的 provider 启用或关闭模型推理。 |
| `request.cache_retention` | `string` | `"short"` | 是 | `request.cache_retention` | 选择传给 pi-ai、与 provider 无关的提示词缓存保留偏好。 |
| `request.max_prompt_tokens` | `integer` | `12000` | 是 | `request.max_prompt_tokens` | 限制每次模型请求组装的提示词 token 数。 |
| `request.request_max_retries` | `integer` | `4` | 是 | `request.request_max_retries` | 限制模型开始输出前发生失败的重试次数。 |
| `request.request_max_retries_by_provider` | `number_map` | `{}` | 否 | `request.request_max_retries_by_provider` | 按 provider 路由覆盖请求重试预算，取 0–100 的整数；未列出路由使用全局预算。config 命令只能读取。 |
| `request.stream_max_retries` | `integer` | `5` | 是 | `request.stream_max_retries` | 限制模型响应流中断后的重试次数。 |
| `request.stream_max_retries_by_provider` | `number_map` | `{}` | 否 | `request.stream_max_retries_by_provider` | 按 provider 路由覆盖流重试预算，取 0–100 的整数；未列出路由使用全局预算。config 命令只能读取。 |
| `tui.clear_on_shrink` | `boolean` | `true` | 是 | `tui_clear_on_shrink` | 视口缩小时清除残留终端单元格。 |
| `tui.color_mode` | `string` | `"auto"` | 是 | `tui_color_mode` | 选择自动、真彩色、256 色、16 色或无颜色输出。 |
| `tui.glyph_mode` | `string` | `"auto"` | 是 | `tui_glyph_mode` | 选择自动、Unicode 或纯 ASCII 界面字符。 |
| `tui.hardware_cursor` | `boolean` | `false` | 是 | `tui_hardware_cursor` | 支持时使用终端光标定位输入法候选框。 |
| `tui.hide_thinking` | `boolean` | `true` | 是 | `tui_hide_thinking` | 隐藏助手响应中的推理块。 |
| `tui.high_contrast` | `boolean` | `false` | 是 | `tui_high_contrast` | 增强状态和选择样式的语义对比。 |
| `tui.reduced_motion` | `boolean` | `false` | 是 | `tui_reduced_motion` | 使用静态进度指示代替终端动画帧。 |
| `tui.statusbar_mode` | `string` | `"full"` | 是 | `tui_statusbar_mode` | 控制页脚显示的会话和模型状态信息量。 |
| `tui.subagent_density` | `string` | `"normal"` | 是 | `tui_subagent_density` | 控制子 Agent 任务摘要的显示密度。 |
| `tui.terminal_notifications` | `boolean` | `true` | 是 | `tui_terminal_notifications` | 终端未聚焦时，在轮次完成或需要用户处理时发送通知。 |
| `tui.terminal_progress` | `boolean` | `true` | 是 | `tui_terminal_progress` | Agent 轮次运行时显示精简进度。 |
| `tui.theme` | `string` | `"dark"` | 是 | `tui_theme` | 选择终端颜色主题。 |
| `tui.tool_details_default` | `string` | `"collapsed"` | 是 | `tui_tool_details_default` | 控制已完成工具详情默认折叠还是展开。 |
| `tui.view_mode` | `string` | `"default"` | 是 | `view_mode` | 控制对话详情密度，并始终保留工具活动可见。 |
| `updates.check_on_startup` | `boolean` | `true` | 是 | `updates.check_on_startup` | 交互启动后启用后台缓存更新检查。 |

<a id="compatibility-aliases"></a>

## 兼容别名

为保持兼容，别名仍可读取，但会产生弃用诊断，并由 `mycli config migrate` 规范化。迁移预览和输出不包含配置值。

- `context.compaction_l4_buffer_tokens`: `compaction_l4_buffer_tokens`
- `context.compaction_l4_carry_cost_per_1k`: `compaction_l4_carry_cost_per_1k`
- `context.compaction_l4_carry_turns`: `compaction_l4_carry_turns`
- `context.compaction_l4_expected_summary_tokens`: `compaction_l4_expected_summary_tokens`
- `context.compaction_l4_input_cost_per_1k`: `compaction_l4_input_cost_per_1k`
- `context.compaction_l4_min_savings_ratio`: `compaction_l4_min_savings_ratio`
- `context.compaction_l4_output_cost_per_1k`: `compaction_l4_output_cost_per_1k`
- `context.compaction_l4_summarizer_model`: `compaction_l4_summarizer_model`
- `context.compaction_l4_trigger_ratio`: `compaction_l4_trigger_ratio`
- `context.compaction_rehydration_file_max_item_tokens`: `compaction_rehydration_file_max_item_tokens`
- `context.compaction_rehydration_file_max_total_tokens`: `compaction_rehydration_file_max_total_tokens`
- `context.compaction_rehydration_max_files`: `compaction_rehydration_max_files`
- `context.compaction_reserved_output_tokens`: `compaction_reserved_output_tokens`
- `context.compaction_tail_max_tokens`: `compaction_tail_max_tokens`
- `context.compaction_tail_turns`: `compaction_tail_turns`
- `context.compaction_token_limit`: `compaction_token_limit`
- `context.compression_threshold_tokens`: `compression_threshold_tokens`
- `features.request_permissions_tool`: `request_permissions_tool`
- `memory.enabled`: `memory_enabled`
- `model.api_base_url`: `api_base_url`
- `model.auth_ref`: `auth_ref`
- `model.name`: `model`
- `model.protocol`: `protocol`
- `model.provider`: `provider`
- `model.supports_images`: `supports_images`
- `reasoning.effort`: `thinking_effort`, `reasoning_effort`, `reasoning.reasoning_effort`
- `reasoning.enabled`: `thinking_enabled`
- `request.cache_retention`: `cache_retention`
- `request.max_prompt_tokens`: `max_prompt_tokens`
- `request.request_max_retries`: `request_max_retries`
- `request.stream_max_retries`: `stream_max_retries`, `transport_retry_limit`
- `tui.clear_on_shrink`: `clearOnShrink`, `clear_on_shrink`
- `tui.color_mode`: `colorMode`, `color_mode`
- `tui.glyph_mode`: `glyphMode`, `glyph_mode`
- `tui.hardware_cursor`: `hardwareCursor`, `hardware_cursor`
- `tui.hide_thinking`: `hideThinking`, `hide_thinking`
- `tui.high_contrast`: `highContrast`, `high_contrast`
- `tui.reduced_motion`: `reducedMotion`, `reduced_motion`
- `tui.statusbar_mode`: `statusbarMode`, `statusbar_mode`, `statusline_enabled`
- `tui.subagent_density`: `subagentDensity`, `subagent_density`
- `tui.terminal_notifications`: `terminalNotifications`, `terminal_notifications`
- `tui.terminal_progress`: `terminalProgress`, `terminal_progress`
- `tui.theme`: `theme`
- `tui.tool_details_default`: `toolDetailsDefault`, `tool_details_default`
- `tui.view_mode`: `viewMode`
- `updates.check_on_startup`: `updates_check_on_startup`
