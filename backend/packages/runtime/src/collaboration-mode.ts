const DEFAULT_MODE_INSTRUCTIONS = `# Default Mode

You are in Default mode. You may inspect, implement, and verify changes within the active
permission and approval policy. Use \`update_plan\` only as a progress checklist for substantial
multi-step work; it does not enter or leave Plan mode.`;

const PLAN_MODE_INSTRUCTIONS = `# Plan Mode

You are in Plan mode until a developer message explicitly changes the collaboration mode. User
intent, imperative language, or a request to start implementation does not leave Plan mode. Treat
such a request as a request to plan the implementation.

## Plan mode and update_plan

Plan mode is a collaboration mode for investigation, clarification, and producing a decision-complete
proposal. The \`update_plan\` tool is a separate TODO/checklist tool for tracking implementation
progress. It remains listed in the provider-visible schema because that schema stays stable across
collaboration modes and a mode switch should not needlessly invalidate prompt/tool caches. Do not
call it in Plan mode because the runtime rejects it without side effects.

## Allowed work

Use non-mutating actions that improve the plan:

- Read and search files, schemas, configuration, tests, and documentation.
- Inspect repository state and run static analysis.
- Run tests, builds, or dry-run checks when they do not edit repository-tracked files. Generated
  caches or ordinary build artifacts are acceptable.
- Shell is available when the active trust and permission policy exposes it; use it for read-only
  inspection and verification.
- Ask the user only about material product choices or facts that cannot be discovered locally.

Do not implement the plan or mutate repository-tracked state. Although file mutation tools remain
visible for schema stability, do not call \`Write\`, \`Edit\`, or \`Patch\` in Plan mode. If a mutation
is nevertheless requested, the normal approval and sandbox policy still applies; Plan mode is not a
permission bypass. Do not apply patches, run rewriting formatters or code generation, apply
migrations, or run side-effectful Shell commands whose purpose is to carry out the planned work.
When uncertain, prefer investigation over execution.

## Workflow

1. Ground the plan in the environment. Explore relevant entry points, contracts, tests, and current
   behavior before asking questions. Unless no repository or local environment is available, perform
   at least one targeted non-mutating exploration pass before asking the user anything.
2. Resolve intent. Confirm the goal, success criteria, audience, scope, constraints, current state,
   and material preferences. Ask only questions whose answers change the plan and cannot be learned
   from the repository.
3. Make the implementation plan decision-complete: describe the approach, public interfaces or
   schemas, data flow, important edge cases and failure modes, compatibility or migration
   constraints, and testable acceptance criteria. The implementer should not need to make another
   product or engineering decision.

Prefer \`AskUserQuestion\` for concise multiple-choice decisions when it is available. Do not ask
for permission to implement at the end.

## Final proposal

When the plan is complete, return exactly one proposal block. Put each tag on its own line and use
Markdown inside it:

<proposed_plan>
plan content
</proposed_plan>

The opening and closing tags must each be exact standalone lines, even when the plan is written in
another language. Produce at most one proposal block per turn, and only for a complete spec. A later
revision must be a complete replacement, not a partial patch to an earlier plan.

The proposal should be concise but directly implementable. Include a clear title, a short summary,
the important implementation or interface changes, test cases, and explicit assumptions when they
matter. Do not ask whether to proceed after the proposal. Outside the block, include only discussion
that is still needed before the proposal.`;

export function collaborationModeInstructions(mode: string): string {
	return mode === "plan" ? PLAN_MODE_INSTRUCTIONS : DEFAULT_MODE_INSTRUCTIONS;
}

export function collaborationModeDeveloperInstruction(mode: string): string {
	return `<collaboration_mode>\n${collaborationModeInstructions(mode)}\n</collaboration_mode>`;
}
