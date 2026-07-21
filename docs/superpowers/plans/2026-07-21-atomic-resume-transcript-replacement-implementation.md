# Atomic Resume Transcript Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make selector and slash-command Resume replace native transcript history exactly once without changing any transcript item content.

**Architecture:** Capture the source session before `/resume` so an early `session.changed` event cannot suppress destination loading. Add a session-transition gate to `MycliShellRuntime`; native history deltas pause during asynchronous replacement, then one synchronized full-history replacement establishes the new watermark.

**Tech Stack:** TypeScript, Node 22 test runner, terminal synchronized output, existing runtime-state reducers.

---

## File Structure

- Modify `tui/mycli-shell/src/adapters/runtime-state.ts`: compare Resume destination with the command's captured source session.
- Modify `tui/mycli-shell/src/gateway.ts`: capture source session and request native replacement only for a real cross-session mutation.
- Modify `tui/mycli-shell/src/shell-runtime.ts`: gate native deltas and expose one atomic session-state replacement operation.
- Modify `tui/mycli-shell/test/gateway-client.test.ts`: reproduce early `session.changed` event ordering.
- Modify `tui/mycli-shell/test/shell-app.test.ts`: reproduce asynchronous selector frames and verify content-preserving single replay.

### Task 1: Preserve Slash Resume Source Identity

**Files:**
- Modify: `tui/mycli-shell/test/gateway-client.test.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`

- [ ] **Step 1: Add the failing early-event test**

Import `reduceRuntimeEvent` if the test does not already import it. Add:

```typescript
test("inline resume uses the source session when session.changed arrives first", async () => {
	const source = {
		...initialRuntimeState(),
		sessionId: "demo-1",
		transcript: [{ id: "source-message", type: "user" as const, text: "source", folded: false }],
	};
	const eventAdvanced = reduceRuntimeEvent(source, "session.changed", {
		session_id: "demo-2",
	});
	let loads = 0;

	const state = await runtimeStateAfterCommandResult(
		eventAdvanced,
		"/resume demo-2",
		{
			mutated_session: true,
			session_id: "demo-2",
			lines: ["Resumed session demo-2"],
		},
		async () => {
			loads += 1;
			return {
				items: [
					{ id: "destination-message", type: "assistant_final", text: "destination", folded: false },
				],
			};
		},
		"demo-1",
	);

	assert.equal(loads, 1);
	assert.equal(state.transcript.some((item) => item.id === "source-message"), false);
	assert.equal(state.transcript[0]?.id, "destination-message");
});
```

- [ ] **Step 2: Verify the test fails for the missing source-session argument**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern="source session when session.changed arrives first"
```

Expected: TypeScript execution fails because `runtimeStateAfterCommandResult` accepts only four arguments, or the test observes `loads === 0` before the signature is enforced.

- [ ] **Step 3: Extend the reducer contract**

Add an optional source session argument and compare against it:

```typescript
export async function runtimeStateAfterCommandResult(
	state: RuntimeShellState,
	command: string,
	result: Record<string, unknown>,
	loadTranscript: (sessionId: string) => Promise<Record<string, unknown>>,
	sourceSessionId: string | null = state.sessionId,
): Promise<RuntimeShellState> {
	const destinationSessionId = stringValue(result.session_id);
	if (
		result.mutated_session !== true ||
		!destinationSessionId ||
		destinationSessionId === sourceSessionId
	) {
		return runtimeStateWithCommandResult(state, command, result);
	}
```

All existing four-argument callers retain current behavior.

- [ ] **Step 4: Capture source identity in `runCommand`**

Replace the direct state update with:

```typescript
async function runCommand(command: string): Promise<void> {
	const sourceSessionId = runtimeState.sessionId;
	const result = await send("command.run", { command, surface: commandSurface });
	const clientAction = clientActionFromResult(result);
	if (clientAction && runtime) {
		await runtime.handleClientAction(clientAction.action, clientAction.args);
		return;
	}
	const nextState = await runtimeStateAfterCommandResult(
		runtimeState,
		command,
		result,
		async (sessionId) =>
			await send("transcript.load", { session_id: sessionId, before: null }),
		sourceSessionId,
	);
	const replacedSession =
		result.mutated_session === true &&
		nextState.sessionId !== null &&
		nextState.sessionId !== sourceSessionId;
	setRuntimeState(nextState, { replaceSessionTranscript: replacedSession });
	if (result.exit_requested === true) {
		await shutdown(0);
	}
}
```

The `setRuntimeState` option is implemented in Task 2. Until then, TypeScript is expected to report that the second argument is unsupported.

- [ ] **Step 5: Run the reducer tests**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern="inline resume|same-session mutation"
```

Expected: reducer behavior tests PASS; typecheck remains pending until Task 2 adds the gateway option.

### Task 2: Gate Native History During Session Replacement

**Files:**
- Modify: `tui/mycli-shell/test/shell-app.test.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/gateway.ts`

- [ ] **Step 1: Add a failing asynchronous selector test**

Add a test using native scrollback and deliberate render frames inside the session callback:

```typescript
test("session selection suppresses transcript deltas until one replacement", async () => {
	const terminal = new TestTerminal();
	terminal.nativeScrollback = true;
	terminal.rows = 12;
	let runtime: MycliShellRuntime;
	const destination = [
		{ id: "same-text-1", role: "user" as const, text: "legitimate repeat" },
		{ id: "same-text-2", role: "user" as const, text: "legitimate repeat" },
		...Array.from({ length: 20 }, (_, index) => ({
			id: `destination-${index}`,
			role: "assistant" as const,
			text: `destination history ${index}`,
		})),
	];
	runtime = new MycliShellRuntime({
		initialState: sampleState(),
		terminal,
		onSessionSelect: async (sessionId) => {
			runtime.setState({
				...runtime.getState(),
				messages: [],
				tools: [],
				bash: [],
				transcript: undefined,
				footer: { ...runtime.getState().footer, sessionName: sessionId },
			});
			await setTimeout(25);
			runtime.setState({
				...runtime.getState(),
				messages: destination,
			});
			await setTimeout(25);
		},
	});

	runtime.start();
	await setTimeout(25);
	runtime.showSessionSelector();
	await setTimeout(25);
	terminal.output = "";
	terminal.input?.("\r");
	await setTimeout(100);

	assert.equal(terminal.output.match(/\x1b\[3J/g)?.length, 1);
	assert.equal(stripAnsi(terminal.output).match(/destination history 0/g)?.length, 1);
	assert.deepEqual(runtime.getState().messages.slice(0, 2), destination.slice(0, 2));
});
```

- [ ] **Step 2: Verify the selector test fails before the gate**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern="suppresses transcript deltas until one replacement"
```

Expected: FAIL because a render frame can commit destination history before the final replacement, or because replacement scheduling is not represented as one transition.

- [ ] **Step 3: Add the runtime transition gate**

Add a depth counter to `MycliShellRuntime`:

```typescript
private sessionTransitionDepth = 0;
```

Suppress normal deltas while it is nonzero:

```typescript
private queueNativeTranscriptDelta(): void {
	if (this.sessionTransitionDepth > 0) return;
	if (!this.ui.terminal.nativeScrollback || !this.mainMounted) return;
```

Wrap selector Resume:

```typescript
private async selectSession(sessionId: string): Promise<void> {
	this.sessionTransitionDepth += 1;
	try {
		this.setState({
			...this.state,
			footer: { ...this.state.footer, sessionName: sessionId },
		});
		await this.options.onSessionSelect?.(sessionId);
		this.queueNativeTranscriptHistory(true);
	} finally {
		this.sessionTransitionDepth -= 1;
	}
}
```

- [ ] **Step 4: Add atomic replacement for slash Resume**

Expose a content-preserving state replacement:

```typescript
replaceSessionState(nextState: MycliShellState): void {
	this.sessionTransitionDepth += 1;
	try {
		this.setState(nextState);
		this.queueNativeTranscriptHistory(true);
	} finally {
		this.sessionTransitionDepth -= 1;
	}
}
```

It delegates all projection and component reconciliation to existing `setState`; it only changes native terminal scheduling.

- [ ] **Step 5: Route the gateway replacement option**

Add the option type and use the new runtime method:

```typescript
function setRuntimeState(
	nextState: RuntimeShellState,
	options: { replaceSessionTranscript?: boolean } = {},
): void {
	runtimeState = nextState;
	if (runtime) {
		const shellState = currentShellState();
		if (options.replaceSessionTranscript) {
			runtime.replaceSessionState(shellState);
		} else {
			runtime.setState(shellState);
		}
	}
	if (nativeRuntime) {
		nativeRuntime.setState(currentShellState());
	}
}
```

- [ ] **Step 6: Run focused Resume tests and typecheck**

```bash
npm --prefix tui/mycli-shell test -- --test-name-pattern="resume|Resume|session selection|same-session mutation"
npm --prefix tui/mycli-shell run typecheck
```

Expected: all focused tests PASS and TypeScript exits 0.

- [ ] **Step 7: Commit the fix**

```bash
git add \
  tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/src/gateway.ts \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/test/gateway-client.test.ts \
  tui/mycli-shell/test/shell-app.test.ts
git commit -m "fix: replace resumed transcript atomically"
```

### Task 3: Regression Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run all Node TUI tests**

```bash
npm --prefix tui/mycli-shell test
```

Expected: all tests PASS.

- [ ] **Step 2: Run TypeScript typecheck**

```bash
npm --prefix tui/mycli-shell run typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 3: Run Python gateway and slash-command regressions**

```bash
uv run pytest -q tests/unit/cli tests/unit/application -k "resume or transcript or slash"
```

Expected: all selected tests PASS.

- [ ] **Step 4: Run task-owned lint checks**

```bash
uv run ruff check src/mycli/cli tests/unit/cli
```

Expected: ruff exits 0 for Python-owned paths. TypeScript is covered by typecheck and tests.

- [ ] **Step 5: Inspect worktree ownership**

```bash
git status --short
git log --oneline -7
```

Expected: only pre-existing `.codex/config.toml`, shell-plan, training artifact, data, and demo-script changes remain uncommitted.
