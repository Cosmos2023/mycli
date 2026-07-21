# Global Tool Detail Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Ctrl+O` globally and persistently toggle every tool and shell detail in the full mycli TUI.

**Architecture:** `MycliShellRuntime` owns a local three-state detail mode (`default`, `expanded`, or `collapsed`). The global input listener consumes `Ctrl+O`, and `setState()` reapplies an explicit mode to every projected tool and shell block so gateway updates cannot reset the user's choice.

**Tech Stack:** TypeScript, mycli-shell TUI runtime, Node.js test runner

---

### Task 1: Lock The Global Toggle Contract With Failing Tests

**Files:**
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Add a state fixture with matching tool and shell transcript blocks**

Add a helper near `sampleState()` that starts with expanded details in both the legacy arrays and canonical transcript:

```ts
function expandedToolDetailState(): MycliShellState {
	const tool = {
		id: "tool-detail",
		name: "Read",
		args: "README.md",
		status: "success" as const,
		outputPreview: "line one\nline two",
		hiddenLineCount: 1,
		expanded: true,
	};
	const bash = {
		id: "shell-detail",
		toolName: "Shell",
		command: "printf 'one\\ntwo\\n'",
		status: "success" as const,
		outputPreview: "one\ntwo",
		expanded: true,
	};
	return {
		...sampleState(),
		messages: [],
		tools: [tool],
		bash: [bash],
		transcript: [
			{ id: tool.id, kind: "tool", tool },
			{ id: bash.id, kind: "bash", bash },
		],
		pendingNotice: undefined,
	};
}
```

- [ ] **Step 2: Add a raw-input test for collapse, refresh inheritance, and re-expansion**

Use `TestTerminal.input` so the test covers the actual TUI input path:

```ts
test("ctrl o globally toggles tool details and survives gateway state refreshes", () => {
	const terminal = new TestTerminal();
	const initial = expandedToolDetailState();
	const runtime = new MycliShellRuntime({ initialState: initial, terminal });
	runtime.start();

	terminal.input?.("\x0f");
	assert.equal(runtime.getState().tools[0]?.expanded, false);
	assert.equal(runtime.getState().bash[0]?.expanded, false);
	assert.equal(runtime.getState().transcript?.[0]?.kind === "tool" && runtime.getState().transcript?.[0].tool.expanded, false);

	const incoming = expandedToolDetailState();
	const newTool = { ...incoming.tools[0]!, id: "tool-new", expanded: true };
	runtime.setState({
		...incoming,
		tools: [...incoming.tools, newTool],
		transcript: [
			...(incoming.transcript ?? []),
			{ id: newTool.id, kind: "tool", tool: newTool },
		],
	});
	assert.deepEqual(runtime.getState().tools.map((tool) => tool.expanded), [false, false]);
	assert.equal(runtime.getState().bash[0]?.expanded, false);

	terminal.input?.("\x0f");
	assert.deepEqual(runtime.getState().tools.map((tool) => tool.expanded), [true, true]);
	assert.equal(runtime.getState().bash[0]?.expanded, true);
});
```

- [ ] **Step 3: Add a modal ownership test**

```ts
test("ctrl o does not toggle tool details while a selector owns input", async () => {
	const terminal = new TestTerminal();
	const runtime = new MycliShellRuntime({
		initialState: expandedToolDetailState(),
		terminal,
		commands: [slashCommand("settings", "/settings", "Open settings")],
	});
	runtime.start();
	await runtime.handleClientAction("open_settings", "");

	terminal.input?.("\x0f");

	assert.equal(runtime.getState().tools[0]?.expanded, true);
	assert.equal(runtime.getState().bash[0]?.expanded, true);
});
```

- [ ] **Step 4: Run the focused tests and verify the global-input test fails**

Run:

```bash
cd tui/mycli-shell
node --import ./node_modules/tsx/dist/esm/index.mjs \
  --test \
  --test-name-pattern="ctrl o" \
  test/shell-app.test.ts
```

Expected: the raw-input test fails because `handleGlobalInput()` does not consume `Ctrl+O`; the modal test passes.

### Task 2: Add Runtime-Owned Tool Detail Mode

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Define local mode state**

Add the local type and field:

```ts
type ToolDetailMode = "default" | "expanded" | "collapsed";

private toolDetailMode: ToolDetailMode = "default";
```

- [ ] **Step 2: Apply explicit mode at every state boundary**

Normalize incoming state before diffing or rebuilding:

```ts
setState(nextState: MycliShellState): void {
	const previousState = this.state;
	const effectiveState = this.applyToolDetailMode(nextState);
	this.updateStatusTiming(previousState, effectiveState);
	this.state = effectiveState;
	if (this.mainMounted) {
		this.rebuildChangedSections(previousState, effectiveState);
	}
	this.maybeResetTranscriptScroll(previousState, effectiveState);
	this.queueNativeTranscriptDelta();
	this.ui.requestRender();
}
```

Implement one immutable projector for arrays and transcript blocks. Leave command-result folding unchanged:

```ts
private applyToolDetailMode(state: MycliShellState): MycliShellState {
	if (this.toolDetailMode === "default") return state;
	const expanded = this.toolDetailMode === "expanded";
	const tools = state.tools.map((tool) => ({ ...tool, expanded }));
	const bash = state.bash.map((item) => ({ ...item, expanded }));
	const toolById = new Map(tools.map((tool) => [tool.id, tool]));
	const bashById = new Map(bash.map((item) => [item.id, item]));
	return {
		...state,
		tools,
		bash,
		transcript: state.transcript?.map((block) => {
			if (block.kind === "tool") {
				return { ...block, tool: toolById.get(block.tool.id) ?? { ...block.tool, expanded } };
			}
			if (block.kind === "bash") {
				return { ...block, bash: bashById.get(block.bash.id) ?? { ...block.bash, expanded } };
			}
			return block;
		}),
	};
}
```

- [ ] **Step 3: Route `Ctrl+O` through the global input listener**

After the modal guard and before scrolling handlers:

```ts
if (matchesKey(data, "ctrl+o")) {
	this.toggleToolDetails();
	return { consume: true };
}
```

- [ ] **Step 4: Replace per-item inversion with one global mode transition**

```ts
private toggleToolDetails(): void {
	if (this.toolDetailMode === "expanded") {
		this.toolDetailMode = "collapsed";
	} else if (this.toolDetailMode === "collapsed") {
		this.toolDetailMode = "expanded";
	} else {
		const blocks = this.state.transcript?.length
			? this.state.transcript
			: this.legacyTranscriptBlocks();
		const hasCollapsed = blocks.some((block) =>
			block.kind === "tool"
				? !block.tool.hidden && block.tool.expanded !== true
				: block.kind === "bash" && block.bash.expanded !== true,
		);
		this.toolDetailMode = hasCollapsed ? "expanded" : "collapsed";
	}
	this.setState(this.state);
}
```

The existing editor action and `toggle_details` client action continue to call this method.

- [ ] **Step 5: Run focused tests and verify they pass**

Run the Task 1 command again.

Expected: both `ctrl o` tests pass.

### Task 3: Verify And Commit

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Test: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Run the complete Node verification**

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: all Node tests and TypeScript type checking pass.

- [ ] **Step 2: Check the scoped diff**

```bash
cd ../..
git diff --check -- \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/test/shell-app.test.ts
```

Expected: no output and exit code zero.

- [ ] **Step 3: Commit the implementation separately from the design**

```bash
git add \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "fix: make tool detail toggle global"
```
