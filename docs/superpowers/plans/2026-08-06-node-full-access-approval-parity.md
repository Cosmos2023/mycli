# Node Full-Access Approval Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Node `full-access` profile skip routine approvals while preserving workspace trust, explicit exec-policy decisions, and fail-closed validation.

**Architecture:** Keep approval precedence inside `ApprovalPolicy` by making it permission-profile aware. Propagate the already validated gateway permission through `NodeTurnRuntime.configureExecutionPolicy`, then prove the real Node backend executes the M6 PTY flow without emitting `approval.request`.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, `node:test`, npm workspaces, existing JSON-RPC gateway and M6 integration harness.

---

## File Map

- Modify `packages/tools/src/approval-policy.ts`: own current permission profile and full-access routine-allow decisions.
- Modify `packages/tools/test/approval-policy.test.ts`: lock direct policy precedence and fail-closed cases.
- Modify `packages/runtime/src/node-turn-runtime.ts`: forward permission changes to the approval-policy contract.
- Modify `packages/runtime/test/node-turn-runtime.test.ts`: prove runtime configuration reaches approval policy.
- Modify `apps/mycli/src/node-runtime/node-backend.ts`: expose the concrete policy configurator through the runtime adapter.
- Modify `apps/mycli/test/m6-persistent-shell.integration.test.ts`: replace the incorrect full-access approval expectation with zero-approval completion.
- Modify `.trellis/spec/backend/runtime-tui-gateway-contract.md`: record executable full-access approval semantics.
- Modify `.trellis/tasks/08-06-node-full-access-approval-parity/prd.md`: mark verified acceptance criteria.

## TDD Execution Order

Before changing production code, complete Task 1 Steps 1-2, Task 2 Steps 1-2, and Task 3 Step 1.
This captures direct policy, runtime propagation, and real backend failures independently. Then
return to Task 1 Step 3 and continue through the remaining implementation and green checks.

### Task 1: Make ApprovalPolicy Permission-Aware

**Files:**
- Modify: `packages/tools/test/approval-policy.test.ts`
- Modify: `packages/tools/src/approval-policy.ts`

- [ ] **Step 1: Write failing policy tests**

Add tests that configure the policy after construction and assert routine requests become allowed,
while explicit rules and invalid input keep their old decisions:

```typescript
test("full access skips routine approval but preserves explicit rules", () => {
	const policy = approvalPolicy({
		autoApproveMedium: false,
		extensionTools: [{ name: "McpSearch", approvalPolicy: "request" }],
	});
	const shell = toolCall("Shell", { command: "python deploy.py" });
	assert.equal(policy.evaluate(shell).kind, "request");

	policy.configurePermissionProfile("full-access");

	assert.equal(policy.evaluate(shell).kind, "allow");
	assert.equal(policy.evaluate(writeCall("notes.txt")).kind, "allow");
	assert.equal(policy.evaluate(toolCall("McpSearch", { query: "docs" })).kind, "allow");
});

test("full access keeps explicit ask deny and invalid calls fail closed", () => {
	const ask = approvalPolicy({
		autoApproveMedium: true,
		execPolicyRules: [{
			source: "project",
			index: 0,
			pattern: ["python", "review.py"],
			decision: "ask",
		}],
	});
	ask.configurePermissionProfile("full-access");
	assert.equal(ask.evaluate(toolCall("Shell", { command: "python review.py" })).kind, "request");
	assert.equal(ask.evaluate({ callId: "bad", name: "Shell", argumentsJson: "not-json" }).kind, "deny");
	assert.equal(ask.evaluate(toolCall("Unknown", {})).kind, "deny");
});
```

Extend the local test helper return type with:

```typescript
configurePermissionProfile(profile: "read-only" | "workspace" | "full-access"): void;
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm run test --workspace @mycli/tools -- --test-name-pattern="full access"
```

Expected: compilation or assertion failure because `ApprovalPolicy` does not expose
`configurePermissionProfile` and routine calls remain requests.

- [ ] **Step 3: Implement the minimal policy state and precedence**

In `ApprovalPolicy` add a profile field and configurator:

```typescript
readonly #autoApproveMedium: boolean;
#permissionProfile: PermissionProfile;

constructor(options: ApprovalPolicyOptions) {
	// existing validation and assignments
	this.#permissionProfile = options.permissionProfile ?? "workspace";
}

configurePermissionProfile(profile: PermissionProfile): void {
	this.#permissionProfile = profile;
}
```

For valid workspace mutations, allow when either full access or medium auto-approval applies:

```typescript
if (this.#permissionProfile === "full-access" || this.#autoApproveMedium) {
	return allow(call, preview);
}
```

For a known request-policy extension, allow after validating the route:

```typescript
if (policy.approvalPolicy === "auto_allow" || this.#permissionProfile === "full-access") {
	return allow(call, `${call.name} local integration`);
}
```

Inside the Shell segment loop, preserve explicit rule handling and allow unmatched routine
segments only after `deny`, `ask`, and `allow` have been evaluated:

```typescript
if (match?.decision === "allow" || isKnownSafeShellSegment(segment, options)) continue;
if (this.#permissionProfile === "full-access") continue;
return shellRequest(/* existing bounded request */);
```

- [ ] **Step 4: Run policy tests and verify GREEN**

Run:

```bash
npm run test --workspace @mycli/tools
```

Expected: all `@mycli/tools` tests pass, including explicit ask/deny and malformed-call coverage.

### Task 2: Propagate Gateway Permission Into ApprovalPolicy

**Files:**
- Modify: `packages/runtime/test/node-turn-runtime.test.ts`
- Modify: `packages/runtime/src/node-turn-runtime.ts`
- Modify: `apps/mycli/src/node-runtime/node-backend.ts`

- [ ] **Step 1: Write the failing runtime propagation test**

Create an `ApprovalPolicy`, pass it to the existing `createRuntime` helper, configure full access,
and assert the concrete policy changed:

```typescript
test("execution policy configuration updates routine approval profile", () => {
	const approvalPolicy = new ApprovalPolicy({
		workspaceRoot: "/workspace",
		autoApproveMedium: true,
		shellKind: "posix",
	});
	const shellCall: CanonicalToolCall = {
		callId: "call-shell",
		name: "Shell",
		argumentsJson: JSON.stringify({ command: "python deploy.py" }),
	};
	const runtime = createRuntime({
		store: new FakeStore([]),
		provider: scriptedProvider([], [], []),
		toolRouter: new SequencedRouter([]),
		approvalPolicy,
	});

	assert.equal(approvalPolicy.evaluate(shellCall).kind, "request");
	runtime.configureExecutionPolicy({ trust: "trusted", permission: "full-access" });
	assert.equal(approvalPolicy.evaluate(shellCall).kind, "allow");
});
```

- [ ] **Step 2: Run the runtime test and verify RED**

Run:

```bash
npm run test --workspace @mycli/runtime -- --test-name-pattern="execution policy configuration"
```

Expected: FAIL because `configureExecutionPolicy` currently updates only
`ExecutionPolicyCoordinator`.

- [ ] **Step 3: Extend and wire the runtime contract**

Import `PermissionProfile` in `node-turn-runtime.ts`, extend the policy contract, and forward the
validated profile:

```typescript
export interface ApprovalPolicyContract {
	evaluate(call: CanonicalToolCall): ApprovalPolicyDecision | Promise<ApprovalPolicyDecision>;
	configurePermissionProfile?(profile: PermissionProfile): void;
}

configureExecutionPolicy(input: ExecutionPolicyConfiguration): void {
	this.#options.executionPolicyCoordinator?.configure(input);
	this.#options.approvalPolicy?.configurePermissionProfile?.(input.permission);
}
```

Expose the concrete method from the Node backend adapter without bypassing exec-policy loading:

```typescript
approvalPolicy: {
	configurePermissionProfile: (profile) => approvalPolicy.configurePermissionProfile(profile),
	evaluate: async (call) => {
		await ensureExecPolicyLoaded();
		return approvalPolicy.evaluate(call);
	},
},
```

- [ ] **Step 4: Run runtime and app type checks**

Run:

```bash
npm run test --workspace @mycli/runtime
npm run typecheck --workspace @mycli/runtime
npm run typecheck --workspace @mycli/app
```

Expected: all commands exit `0`.

### Task 3: Correct the Real M6 Full-Access Contract

**Files:**
- Modify: `apps/mycli/test/m6-persistent-shell.integration.test.ts`
- Modify: `.trellis/spec/backend/runtime-tui-gateway-contract.md`

- [ ] **Step 1: Change the M6 expectation and verify RED before production edits**

After `permissions.update(full-access)`, remove approval-response handling and assert the turn
completes directly:

```typescript
send(backend, "turn", "turn.submit", submission);
const final = await waitFor(() => messages.find(isFinalMessage), 8_000);
assert.equal(events(messages, "approval.request").length, 0);
assert.equal(isObject(final.params) ? final.params.text : undefined, "PTY completed.");
```

Run before applying Tasks 1-2 production edits:

```bash
npm run build
node --import tsx --test apps/mycli/test/m6-persistent-shell.integration.test.ts
```

Expected: FAIL by observing `approval.request` or timing out before final completion.

- [ ] **Step 2: Run the corrected integration after Tasks 1-2**

Run the same command after implementation.

Expected: PASS with zero `approval.request`, three bounded provider requests, one
`shell.started`, one `shell.completed`, and no Python marker.

- [ ] **Step 3: Update the executable gateway contract**

Add the full-access approval matrix to the existing permission scenario in
`.trellis/spec/backend/runtime-tui-gateway-contract.md`:

```markdown
- `full-access` sets `danger-full-access` execution policy and skips routine approval only after
  valid tool parsing and explicit exec-policy `deny`/`ask`/`allow` evaluation.
- Workspace trust remains an independent precondition. Clarification and authentication are not
  security approvals and remain interactive.
```

- [ ] **Step 4: Run focused and full quality gates**

Run:

```bash
npm run lint
npm run typecheck
npm run test:m6
npm run test:m8
npm test
git diff --check
```

Expected: every command exits `0`; M6 full access emits no approval request; M8 audit remains
unchanged and green.

- [ ] **Step 5: Mark task acceptance criteria and prepare one coherent fix commit**

Mark verified PRD checkboxes, then stage only task-owned files. Keep these unrelated files
unstaged:

```text
docs/superpowers/plans/2026-08-05-responses-cache-demo.md
docs/superpowers/specs/2026-08-05-responses-cache-demo-design.md
scripts/demo_responses_cache.py
tests/unit/scripts/test_demo_responses_cache.py
```

Proposed commit message:

```text
fix(node-runtime): honor full-access approval policy
```
