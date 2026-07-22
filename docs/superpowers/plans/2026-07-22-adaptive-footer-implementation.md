# Adaptive Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's noisy three-line bottom chrome with a width-safe two-row footer whose actions and status reflect the current interaction state.

**Architecture:** `FooterComponent` receives the existing footer model plus a small interaction-state object and owns both rows under one width budget. `MycliShellRuntime` stops rendering its separate composer hint and passes running and queued-input state into the footer; the static shell renderer uses idle defaults.

**Tech Stack:** TypeScript, mycli-shell TUI components, Node.js test runner

---

### Task 1: Lock The Adaptive Footer Contract

**Files:**
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Replace legacy footer assertions with idle and exceptional-state tests**

Add focused tests that render `FooterComponent` directly:

```ts
test("footer renders two quiet idle rows", () => {
	const lines = new FooterComponent({
		cwd: "/Users/cosmos/Desktop/mycli/.worktrees/mycli-termcn-tui-polish",
		gitBranch: "feature/tui",
		sessionName: "现在都有哪些 skill 呢",
		provider: "deepseek/chat_completions",
		model: "deepseek-v4-flash",
		reasoningLevel: "medium",
		contextPercent: 11.3,
		contextWindow: 100000,
		trust: "trusted",
		collaborationMode: "default",
		liveState: "Idle",
		totalInputTokens: 64291,
		cacheReadTokens: 53120,
	}, { turnRunning: false, hasQueuedInput: false }).render(120);
	const output = stripAnsi(lines.join("\n"));

	assert.equal(lines.length, 2);
	assert.match(output, /enter send/);
	assert.match(output, /tab follow-up/);
	assert.match(output, /11\.3% ctx/);
	assert.match(output, /deepseek-v4-flash/);
	assert.doesNotMatch(output, /provider|deepseek\/chat_completions|trust trusted|mode default|Idle|64291|53120/);
});

test("footer exposes only actions and exceptional state that currently apply", () => {
	const output = stripAnsi(new FooterComponent({
		cwd: "/repo",
		model: "gpt-5.4",
		trust: "unknown",
		collaborationMode: "plan",
		liveState: "Running",
		backgroundShellCount: 2,
	}, { turnRunning: true, hasQueuedInput: true }).render(140).join("\n"));

	assert.match(output, /enter steer/);
	assert.match(output, /tab follow-up/);
	assert.match(output, /ctrl\+c interrupt/);
	assert.match(output, /option\+up edit follow-up/);
	assert.match(output, /trust\?/);
	assert.match(output, /plan/);
	assert.match(output, /Running/);
	assert.match(output, /2 background terminals/);
});
```

- [ ] **Step 2: Add responsive-priority and CJK width tests**

```ts
test("footer drops git branch before session title on narrow terminals", () => {
	const lines = new FooterComponent({
		cwd: "/Users/cosmos/Desktop/mycli/.worktrees/mycli-termcn-tui-polish",
		gitBranch: "feature/a-very-long-branch",
		sessionName: "修复 TUI 底栏",
		model: "deepseek-v4-flash",
		contextPercent: 11,
	}, { turnRunning: false, hasQueuedInput: false }).render(48);
	const output = stripAnsi(lines.join("\n"));

	assert.match(output, /修复 TUI 底栏/);
	assert.doesNotMatch(output, /feature\/a-very-long-branch/);
	assert.equal(lines.length, 2);
	for (const line of lines) assert.ok(visibleWidth(line) <= 48);
});
```

Also assert that the branch appears at width 140, and that a 24-column render containing a long CJK title never wraps or exceeds 24 cells.

- [ ] **Step 3: Run focused tests and verify they fail**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test \
  --test-name-pattern="footer" test/shell-app.test.ts
```

Expected: FAIL because the constructor has no interaction-state input and the old footer still renders usage counters and defaults.

### Task 2: Implement The Two-Row Semantic Renderer

**Files:**
- Modify: `tui/mycli-shell/src/components/footer.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add the interaction-state contract**

```ts
export type FooterInteractionState = {
	turnRunning: boolean;
	hasQueuedInput: boolean;
};

const idleInteraction: FooterInteractionState = {
	turnRunning: false,
	hasQueuedInput: false,
};
```

Accept it as an optional second constructor argument so static callers remain source-compatible:

```ts
constructor(
	private readonly data: MycliShellFooterData,
	private readonly interaction: FooterInteractionState = idleInteraction,
) {}
```

- [ ] **Step 2: Build the working-context row with semantic fallback**

Create focused helpers that sanitize each segment, shorten home-relative paths to `~/.../<leaf>` when necessary, and render in this order:

```ts
const session = this.data.sessionName ? `* ${sanitizeStatusText(this.data.sessionName)}` : "";
const branch = this.data.gitBranch ? `(${sanitizeStatusText(this.data.gitBranch)})` : "";
```

Try `path + session + branch`, then remove `branch`, then shorten `path`, and only then truncate the composed row. Use `visibleWidth()` and `truncateToWidth()` for every fit decision so CJK width is correct.

- [ ] **Step 3: Build conditional action and status segments**

Build the left side from current actions:

```ts
const actions = [
	rawKeyHint("enter", this.interaction.turnRunning ? "steer" : "send"),
	rawKeyHint("tab", "follow-up"),
	this.interaction.turnRunning ? rawKeyHint("ctrl+c", "interrupt") : undefined,
	this.interaction.hasQueuedInput ? rawKeyHint("alt+up", "edit follow-up") : undefined,
].filter((part): part is string => Boolean(part));
```

Build the right side only from meaningful state: unknown or untrusted trust, Plan mode, non-idle live state, active background terminals, context percentage, model, and reasoning level. Do not add provider, cumulative token, cache, hit-rate, or cost fields.

- [ ] **Step 4: Fit the second row by dropping optional segments**

Join actions with ` * ` and status with ` | `. Preserve the primary Enter action and exceptional state. Drop optional segments in this order when the row does not fit: edit-follow-up, task progress, reasoning level, model, context, tab-follow-up. Truncate only the final remaining left or right segment, and ensure the output is one visual line.

- [ ] **Step 5: Preserve extension status behavior**

Append sanitized extension status lines after the two base rows using the existing width-safe truncation. Keep these outside the two-row base contract.

- [ ] **Step 6: Run focused footer tests**

Run the command from Task 1.

Expected: all footer tests PASS.

- [ ] **Step 7: Commit the component change**

```bash
git add tui/mycli-shell/src/components/footer.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: add adaptive two-row footer"
```

### Task 3: Integrate Runtime Interaction State

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/shell-app.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add a failing runtime test**

Update the mounted-runtime assertion to require the model and action footer but reject the old composer line:

```ts
const output = stripAnsi(runtime.ui.render(100).join("\n"));
assert.match(output, /enter send/);
assert.match(output, /deepseek-v4-flash/);
assert.doesNotMatch(output, /Message mycli/);
```

Add a state-transition test that changes `liveState` from `Idle` to `Running`, then sets `hasPendingInput: true`, and verifies `enter steer`, `ctrl+c interrupt`, and `option+up edit follow-up` appear at the right times.

- [ ] **Step 2: Make runtime footer assembly atomic**

Replace the separate composer hint and footer children in `rebuildFooter()`:

```ts
private rebuildFooter(): void {
	this.footerContainer.clear();
	this.footerContainer.addChild(new Spacer(1));
	this.footerContainer.addChild(new FooterComponent(this.state.footer, {
		turnRunning: this.isTurnRunning(),
		hasQueuedInput: this.state.footer.hasPendingInput === true,
	}));
}
```

The existing footer signature already includes `liveState` and `hasPendingInput`, so those transitions rebuild the component without adding another invalidation path.

- [ ] **Step 3: Align the static renderer**

Remove `MycliShellApp.composerHint()` and its separate `Text` child. Construct `FooterComponent` with idle interaction state so snapshots and non-interactive rendering use the same two-row layout.

- [ ] **Step 4: Run focused runtime and footer tests**

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs --test \
  --test-name-pattern="footer|mounted containers" test/shell-app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run complete verification**

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all Node TUI tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit runtime integration**

```bash
git add tui/mycli-shell/src/shell-runtime.ts tui/mycli-shell/src/shell-app.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "feat: integrate adaptive runtime footer"
```
