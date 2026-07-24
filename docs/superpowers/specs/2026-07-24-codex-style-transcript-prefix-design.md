# Codex-Style Transcript Prefix Design

## Goal

Align normal conversation messages with Codex's transcript layout without shifting the entire TUI content area.

## Rendering

- Render the first visual line of each user message with the two-cell prefix `› `.
- Render the first visual line of each assistant message with `• `.
- Render every continuation line with two leading spaces so wrapped content remains aligned with the first line's text.
- Subtract the two-cell prefix width before wrapping message content.
- Preserve the existing internal indentation of Markdown lists, code blocks, tables, and quoted text inside the message body.

Example:

```text
› 不是mycli的问题


• 对，这次不是 mycli 的问题。

  第三轮到第四轮请求保持严格 append-only，缓存键、instructions、tools
  都没变化。
```

## Scope

- Apply the prefix and hanging indent to normal user and assistant transcript messages.
- Keep tool calls and tool results on their existing Codex-style rendering path.
- Do not move the editor, separators, footer, command results, overlays, or the global viewport.
- Preserve ANSI styling while measuring the prefix and wrapped content by terminal cell width.

## Responsive Behavior

- Use the same two-cell prefix at normal widths.
- Continue using the existing narrow-terminal wrapping behavior with the available message width reduced by two cells.
- Never emit a rendered line wider than the terminal content width.

## Verification

- Add focused rendering tests for user and assistant first-line prefixes.
- Test wrapped CJK and ASCII continuation lines.
- Verify Markdown indentation remains relative to the two-cell message gutter.
- Run the existing shell app and resize-related test suites to catch width regressions.
