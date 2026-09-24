# Configuration Reference

> Generated from the canonical mycli setting descriptors. Do not edit by hand.

Reference version: 1

Configuration precedence, highest first: session, environment, trusted project, selected
profile, user, system, legacy user, then built-in defaults. Credentials belong in
`~/.mycli/auth.json` or the process environment and are never valid reference settings.

| Key | Type | Default | Writable | Canonical TOML path | Description |
| --- | --- | --- | :---: | --- | --- |
| `context.compaction_l4_buffer_tokens` | `integer` | `13000` | yes | `context.compaction_l4_buffer_tokens` | Keeps this many prompt tokens free when deciding whether automatic compaction should run. |
| `context.compaction_l4_carry_cost_per_1k` | `number` | `0` | yes | `context.compaction_l4_carry_cost_per_1k` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_l4_carry_turns` | `integer` | `1` | yes | `context.compaction_l4_carry_turns` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_l4_expected_summary_tokens` | `integer` | `500` | yes | `context.compaction_l4_expected_summary_tokens` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_l4_input_cost_per_1k` | `number` | `0` | yes | `context.compaction_l4_input_cost_per_1k` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_l4_min_savings_ratio` | `number` | `unset` | yes | `context.compaction_l4_min_savings_ratio` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_l4_output_cost_per_1k` | `number` | `0` | yes | `context.compaction_l4_output_cost_per_1k` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_l4_summarizer_model` | `string` | `unset` | yes | `context.compaction_l4_summarizer_model` | Selects an optional model override for compaction summaries. |
| `context.compaction_l4_trigger_ratio` | `number` | `0.9` | yes | `context.compaction_l4_trigger_ratio` | Starts automatic compaction when estimated prompt use reaches this fraction of the active context window. |
| `context.compaction_l4_trigger_ratios_by_model` | `number_map` | `{}` | no | `context.compaction_l4_trigger_ratios_by_model` | Reports per-model compaction trigger overrides; this structured setting is read-only through config commands. |
| `context.compaction_rehydration_file_max_item_tokens` | `integer` | `5000` | yes | `context.compaction_rehydration_file_max_item_tokens` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_rehydration_file_max_total_tokens` | `integer` | `50000` | yes | `context.compaction_rehydration_file_max_total_tokens` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_rehydration_max_files` | `integer` | `5` | yes | `context.compaction_rehydration_max_files` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_reserved_output_tokens` | `integer` | `13000` | yes | `context.compaction_reserved_output_tokens` | Reserves context capacity for the next model response during compaction budgeting. |
| `context.compaction_tail_max_tokens` | `integer` | `20000` | yes | `context.compaction_tail_max_tokens` | Caps retained user-message text after compaction (default 20000 tokens); the boundary message is truncated with a marker. |
| `context.compaction_tail_turns` | `integer` | `2` | yes | `context.compaction_tail_turns` | Legacy compatibility setting; unused by local context compaction. |
| `context.compaction_token_limit` | `integer` | `9600` | yes | `context.compaction_token_limit` | Sets the prompt-token ceiling used to trigger compaction. |
| `context.compression_threshold_tokens` | `integer` | `8000` | yes | `context.compression_threshold_tokens` | Caps one model-visible tool result (estimated at four bytes per token, capped at 8000 characters); longer results are truncated with a marker before they are recorded. |
| `features.request_permissions_tool` | `boolean` | `false` | yes | `features.request_permissions_tool` | Exposes the structured permission-request tool when the active runtime supports it. |
| `memory.enabled` | `boolean` | `false` | yes | `memory.enabled` | Enables durable memory discovery and injection for the active agent runtime. |
| `model.api_base_url` | `string` | `"https://api.openai.com/v1"` | yes | `model.api_base_url` | Sets the HTTP(S) API endpoint used by the configured provider. |
| `model.auth_ref` | `string` | `"openai"` | yes | `model.auth_ref` | Selects the credential-store reference without placing a credential in TOML. |
| `model.name` | `string` | `"gpt-5.5"` | yes | `model.name` | Selects the provider model used for new runtime requests. |
| `model.protocol` | `string` | `"responses"` | yes | `model.protocol` | Selects the provider wire protocol used for model requests. |
| `model.provider` | `string` | `"openai"` | yes | `model.provider` | Selects a stable profile or an explicitly configured provider route. |
| `model.supports_images` | `boolean` | `false` | yes | `model.supports_images` | Overrides whether the selected compatible endpoint accepts image inputs. |
| `model.web_search_mode` | `string` | `"live"` | no | `model.web_search_mode` | Reports the web-search mode derived from provider capabilities; this setting is read-only. |
| `reasoning.effort` | `string` | `"medium"` | yes | `reasoning.effort` | Selects the reasoning effort requested from models that support effort controls. |
| `reasoning.enabled` | `boolean` | `true` | yes | `reasoning.enabled` | Enables or disables model reasoning for providers that expose this capability. |
| `request.cache_retention` | `string` | `"short"` | yes | `request.cache_retention` | Selects the provider-neutral prompt-cache retention preference passed to pi-ai. |
| `request.max_prompt_tokens` | `integer` | `12000` | yes | `request.max_prompt_tokens` | Caps the prompt tokens assembled for each model request. |
| `request.request_max_retries` | `integer` | `4` | yes | `request.request_max_retries` | Limits retries for failures that occur before model output begins. |
| `request.request_max_retries_by_provider` | `number_map` | `{}` | no | `request.request_max_retries_by_provider` | Overrides request retry budgets by provider route with integers from 0 to 100; omitted routes use the global budget. Read-only through config commands. |
| `request.stream_max_retries` | `integer` | `5` | yes | `request.stream_max_retries` | Limits retries for interrupted model response streams. |
| `request.stream_max_retries_by_provider` | `number_map` | `{}` | no | `request.stream_max_retries_by_provider` | Overrides stream retry budgets by provider route with integers from 0 to 100; omitted routes use the global budget. Read-only through config commands. |
| `tui.clear_on_shrink` | `boolean` | `true` | yes | `tui_clear_on_shrink` | Clears stale terminal cells after the viewport becomes smaller |
| `tui.color_mode` | `string` | `"auto"` | yes | `tui_color_mode` | Selects automatic, truecolor, 256-color, 16-color, or no-color output |
| `tui.glyph_mode` | `string` | `"auto"` | yes | `tui_glyph_mode` | Selects automatic, Unicode, or ASCII-only interface glyphs |
| `tui.hardware_cursor` | `boolean` | `false` | yes | `tui_hardware_cursor` | Uses the terminal cursor for IME placement when supported |
| `tui.hide_thinking` | `boolean` | `true` | yes | `tui_hide_thinking` | Hides reasoning blocks in assistant responses |
| `tui.high_contrast` | `boolean` | `false` | yes | `tui_high_contrast` | Uses stronger semantic contrast for status and selection tokens |
| `tui.reduced_motion` | `boolean` | `false` | yes | `tui_reduced_motion` | Uses static progress indicators instead of animated terminal frames |
| `tui.statusbar_mode` | `string` | `"full"` | yes | `tui_statusbar_mode` | Controls how much session and model status is shown in the footer |
| `tui.subagent_density` | `string` | `"normal"` | yes | `tui_subagent_density` | Controls the density of subagent task summaries |
| `tui.terminal_notifications` | `boolean` | `true` | yes | `tui_terminal_notifications` | Notifies when unfocused and a turn finishes or needs your attention |
| `tui.terminal_progress` | `boolean` | `true` | yes | `tui_terminal_progress` | Shows compact progress while an agent turn is running |
| `tui.theme` | `string` | `"dark"` | yes | `tui_theme` | Selects the terminal color theme |
| `tui.tool_details_default` | `string` | `"collapsed"` | yes | `tui_tool_details_default` | Controls whether completed tool details start collapsed or expanded |
| `tui.view_mode` | `string` | `"default"` | yes | `view_mode` | Controls transcript detail density while keeping tool activity visible |
| `updates.check_on_startup` | `boolean` | `true` | yes | `updates.check_on_startup` | Enables the background cached update check after interactive startup. |

## Compatibility Aliases

Aliases remain readable for compatibility, emit deprecation diagnostics, and are normalized by
`mycli config migrate`. The migration preview and output never include configured values.

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
