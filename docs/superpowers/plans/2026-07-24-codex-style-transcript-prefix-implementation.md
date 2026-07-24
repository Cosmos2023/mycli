# Codex-Style Transcript Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render normal user and assistant transcript messages with Codex-style `› ` and `• ` prefixes plus two-cell hanging indentation.

**Architecture:** Add a small terminal-cell-aware layout helper that reserves two columns before Markdown is rendered and then applies a first-line role prefix or continuation indentation. Keep role-specific spacing and styling in the existing user and assistant components; do not alter the transcript container, tools, editor, footer, or viewport.

**Tech Stack:** TypeScript, custom mycli TUI components, `marked`, Node test runner, `tsx`.

---

## File Structure

- Create `tui/mycli-shell/src/components/transcript-message-layout.ts`: shared two-cell prefix width calculation and line composition.
- Modify `tui/mycli-shell/src/components/user-message.ts`: replace the background box with Codex-style user marker while preserving vertical spacing and OSC 133 zones.
- Modify `tui/mycli-shell/src/components/assistant-message.ts`: apply the assistant marker to visible thinking/text content while preserving its current spacing and update behavior.
- Create `tui/mycli-shell/test/transcript-message-components.test.ts`: focused role prefix, CJK wrapping, Markdown indentation, width, and update tests.
- Modify `tui/mycli-shell/test/shell-app.test.ts`: assert the integrated transcript uses role markers while tools and footer remain on their existing paths.

### Task 1: Add the terminal-width-aware prefix layout helper

**Files:**
- Create: `tui/mycli-shell/src/components/transcript-message-layout.ts`
- Test: `tui/mycli-shell/test/transcript-message-components.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create the test file with focused assertions for first-line and continuation prefixes:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
	renderTranscriptMessageLines,
	transcriptMessageContentWidth,
} from "../src/components/transcript-message-layout.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";

test("transcript message layout applies a role marker and hanging indent", () => {
	const lines = renderTranscriptMessageLines(["alpha", "beta"], 10, "› ");

	assert.equal(lines[0]?.trimEnd(), "› alpha");
	assert.equal(lines[1]?.trimEnd(), "  beta");
	assert.equal(lines.every((line) => visibleWidth(line) === 10), true);
});

test("transcript message layout reserves exactly two terminal cells", () => {
	assert.equal(transcriptMessageContentWidth(80), 78);
	assert.equal(transcriptMessageContentWidth(2), 1);
	assert.equal(transcriptMessageContentWidth(1), 1);
});
```

- [ ] **Step 2: Run the helper tests and verify RED**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/transcript-message-components.test.ts
```

Expected: FAIL because `transcript-message-layout.ts` does not exist.

- [ ] **Step 3: Implement the minimal layout helper**

Create `tui/mycli-shell/src/components/transcript-message-layout.ts`:

```ts
import { truncateToWidth } from "../tui-core/utils.ts";

export const TRANSCRIPT_MESSAGE_PREFIX_WIDTH = 2;

export function transcriptMessageContentWidth(width: number): number {
	const safeWidth = Math.max(1, Math.floor(width));
	return Math.max(1, safeWidth - TRANSCRIPT_MESSAGE_PREFIX_WIDTH);
}

export function renderTranscriptMessageLines(
	contentLines: string[],
	width: number,
	firstLinePrefix: string,
): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	const continuationPrefix = " ".repeat(TRANSCRIPT_MESSAGE_PREFIX_WIDTH);
	return contentLines.map((line, index) =>
		truncateToWidth(
			`${index === 0 ? firstLinePrefix : continuationPrefix}${line}`,
			safeWidth,
			"",
			true,
		),
	);
}
```

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run the Step 2 command again.

Expected: `2` tests pass.

- [ ] **Step 5: Commit the helper**

```bash
git add tui/mycli-shell/src/components/transcript-message-layout.ts tui/mycli-shell/test/transcript-message-components.test.ts
git commit -m "feat(tui): add transcript role prefix layout"
```

### Task 2: Apply Codex-style prefixes to user and assistant messages

**Files:**
- Modify: `tui/mycli-shell/src/components/user-message.ts`
- Modify: `tui/mycli-shell/src/components/assistant-message.ts`
- Test: `tui/mycli-shell/test/transcript-message-components.test.ts`

- [ ] **Step 1: Add failing component behavior tests**

Append these tests to `transcript-message-components.test.ts`:

```ts
import { AssistantMessageComponent } from "../src/components/assistant-message.ts";
import { UserMessageComponent } from "../src/components/user-message.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function visibleContentLines(lines: string[]): string[] {
	return lines.map(stripAnsi).filter((line) => line.trim().length > 0);
}

test("user and assistant messages render Codex-style role prefixes", () => {
	const user = visibleContentLines(new UserMessageComponent("不是mycli的问题").render(40));
	const assistant = visibleContentLines(
		new AssistantMessageComponent("对，这次不是 mycli 的问题。").render(40),
	);

	assert.equal(user[0]?.startsWith("› "), true);
	assert.equal(assistant[0]?.startsWith("• "), true);
});

test("wrapped CJK transcript lines use a two-cell hanging indent", () => {
	const lines = visibleContentLines(
		new AssistantMessageComponent("第三轮到第四轮请求保持严格追加，缓存键和工具定义都没有变化。").render(18),
	);

	assert.equal(lines.length > 1, true);
	assert.equal(lines[0]?.startsWith("• "), true);
	assert.equal(lines.slice(1).every((line) => line.startsWith("  ")), true);
	assert.equal(lines.every((line) => visibleWidth(line) <= 18), true);
});

test("Markdown indentation remains inside the transcript hanging indent", () => {
	const lines = visibleContentLines(
		new AssistantMessageComponent("- first item with enough text to wrap onto another line").render(24),
	);

	assert.equal(lines[0]?.startsWith("• "), true);
	assert.equal(lines.slice(1).every((line) => line.startsWith("  ")), true);
});

test("assistant message updates retain the role prefix", () => {
	const component = new AssistantMessageComponent("partial");
	component.updateMessage("complete response");
	const lines = visibleContentLines(component.render(30));

	assert.equal(lines[0]?.startsWith("• complete response"), true);
});
```

- [ ] **Step 2: Run the component tests and verify RED**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/transcript-message-components.test.ts
```

Expected: helper tests pass; component tests fail because messages still use the old card/padding layout and have no role prefixes.

- [ ] **Step 3: Update `UserMessageComponent`**

Replace the background `Box` with a zero-padding `Markdown` child. In `render(width)`, render that child at `transcriptMessageContentWidth(width)`, compose it with `renderTranscriptMessageLines(..., theme.fg("accent", "› "))`, and retain one full-width blank line above and below the content. Apply the existing OSC 133 start/end markers after composing the final lines.

The resulting render flow must be equivalent to:

```ts
const safeWidth = Math.max(1, Math.floor(width));
const content = super.render(transcriptMessageContentWidth(safeWidth));
const lines = content.length === 0
	? []
	: [
		" ".repeat(safeWidth),
		...renderTranscriptMessageLines(content, safeWidth, theme.fg("accent", "› ")),
		" ".repeat(safeWidth),
	];
```

Keep `preserveOrderedListMarkers: true` and `userMessageText` foreground styling. Remove the `userMessageBg` application so the user message is no longer a full-width colored card.

- [ ] **Step 4: Update `AssistantMessageComponent`**

Render assistant Markdown with `paddingX = 0`. Remove the leading `Spacer(1)` from `rebuild()` and instead prepend one full-width blank line in `render(width)`. Render the internal thinking/text container at `transcriptMessageContentWidth(width)`, then compose it with:

```ts
renderTranscriptMessageLines(content, safeWidth, theme.fg("text", "• "))
```

Keep the spacer between visible thinking and final text, preserve `thinkingText` styling, and apply the existing OSC 133 markers to the final composed output.

- [ ] **Step 5: Run the component tests and verify GREEN**

Run the Step 2 command again.

Expected: all `6` focused tests pass.

- [ ] **Step 6: Commit the component integration**

```bash
git add tui/mycli-shell/src/components/user-message.ts tui/mycli-shell/src/components/assistant-message.ts tui/mycli-shell/test/transcript-message-components.test.ts
git commit -m "feat(tui): render codex-style conversation prefixes"
```

### Task 3: Verify shell integration and resize-safe widths

**Files:**
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add a failing shell integration assertion**

In `mycli shell renders promoted shell surfaces`, add assertions against the ANSI-stripped output:

```ts
assert.match(output, /^› Read word\.txt and summarize it\./m);
assert.match(output, /^• Summary: hello\./m);
assert.match(output, /^• Ran pytest -q/m);
assert.match(output, /^~\/Desktop\/mycli/m);
```

The last two assertions protect tool and footer placement from receiving an extra conversation prefix.

- [ ] **Step 2: Run the shell integration test**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test --test-name-pattern="mycli shell renders promoted shell surfaces" test/shell-app.test.ts
```

Expected after Task 2: PASS. If the footer includes additional status text on the same line, keep the start-of-line assertion and match only the stable path prefix.

- [ ] **Step 3: Run focused transcript and resize tests**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test test/transcript-message-components.test.ts test/tty-terminal.test.ts
```

Expected: all tests pass with no rendered line exceeding its requested width.

- [ ] **Step 4: Run typecheck and the complete TUI suite**

Run:

```bash
cd tui/mycli-shell
npm run typecheck
npm test
```

Expected: TypeScript exits `0`; the complete Node test suite passes.

- [ ] **Step 5: Commit integration coverage**

```bash
git add tui/mycli-shell/test/shell-app.test.ts
git commit -m "test(tui): cover codex-style transcript layout"
```
