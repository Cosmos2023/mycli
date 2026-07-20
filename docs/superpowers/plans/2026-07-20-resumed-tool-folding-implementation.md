# Resumed Tool Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep historical tools collapsed by default when resuming a session while preserving explicit fold state and live tool preferences.

**Architecture:** Normalize only tool items entering through `runtimeStateFromTranscript()`, which is the persisted-history boundary. Missing fold state becomes `folded: true`; explicit values pass through unchanged, and live reducer items remain governed by the existing projection and settings path.

**Tech Stack:** TypeScript, Node.js test runner, mycli runtime-state adapter

---

### Task 1: Normalize Resumed Tool Fold State

**Files:**
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts:376-392`
- Test: `tui/mycli-shell/test/runtime-state.test.ts:260-290`

- [ ] **Step 1: Replace the existing resumed-default test with explicit history cases**

Update the tool detail setting test so an expanded global preference still
collapses resumed tool and shell items whose persisted `folded` value is absent,
while preserving an explicit expanded item:

```ts
test("runtime adapter collapses resumed tools without overriding explicit fold state", () => {
	let state = initialRuntimeState();
	state = runtimeStateWithSettings(state, { toolDetailsDefault: "expanded" });
	state = runtimeStateFromTranscript(state, {
		items: [
			{
				id: "t1",
				type: "tool_summary",
				text: "Read pyproject.toml\nline 2",
				metadata: { tool_name: "Read", path: "pyproject.toml", success: true },
			},
			{
				id: "b1",
				type: "tool_summary",
				text: "pytest -q\n1 passed",
				metadata: { tool_name: "Bash", command: "pytest -q", success: true },
			},
			{
				id: "t2",
				type: "tool_summary",
				text: "Read README.md",
				folded: false,
				metadata: { tool_name: "Read", path: "README.md", success: true },
			},
		],
	});

	const shell = projectRuntimeState(state);

	assert.equal(shell.tools[0]?.expanded, false);
	assert.equal(shell.bash[0]?.expanded, false);
	assert.equal(shell.tools[1]?.expanded, true);
});
```

- [ ] **Step 2: Add a projection test proving non-resumed items still honor the setting**

Construct a runtime item directly rather than loading it through
`runtimeStateFromTranscript()`:

```ts
test("runtime adapter keeps expanded defaults for non-resumed tool items", () => {
	let state = runtimeStateWithSettings(initialRuntimeState(), { toolDetailsDefault: "expanded" });
	state = {
		...state,
		transcript: [
			{
				id: "live-tool",
				type: "tool_summary",
				text: "Read live.txt",
				metadata: { tool_name: "Read", path: "live.txt", success: true },
			},
		],
	};

	assert.equal(projectRuntimeState(state).tools[0]?.expanded, true);
});
```

- [ ] **Step 3: Run the focused tests and verify the resumed test fails**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs \
  --test \
  --test-name-pattern="collapses resumed tools|expanded defaults for non-resumed" \
  --test-reporter=dot \
  test/runtime-state.test.ts
```

Expected: the resumed-history test fails because `t1` and `b1` are expanded;
the non-resumed projection test passes.

- [ ] **Step 4: Normalize missing fold state at the persisted-history boundary**

In `runtimeStateFromTranscript()`, normalize only the items read from `payload`:

```ts
	const resumedItems = items.map((item) =>
		isToolTranscriptItem(item) && item.folded === undefined
			? { ...item, folded: true }
			: item,
	);
	const transcript = coalesceResumedShellOutputItems(
		coalesceLegacyToolItems([...state.transcript, ...resumedItems]),
	);
```

This retains `folded: false`, retains `folded: true`, and leaves pre-existing
live items in `state.transcript` untouched.

- [ ] **Step 5: Run focused tests and the full verification suite**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs \
  --test \
  --test-name-pattern="collapses resumed tools|expanded defaults for non-resumed" \
  --test-reporter=dot \
  test/runtime-state.test.ts
npm test
npm run typecheck

cd ../..
uv run pytest -q
uv run ruff check src tests
uv run mypy src
```

Expected: both focused tests pass; all Node, Python, lint, and type checks pass.

- [ ] **Step 6: Commit the scoped implementation**

```bash
git add \
  tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/test/runtime-state.test.ts
git commit -m "fix: collapse resumed tool history"
```
