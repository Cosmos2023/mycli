export interface SessionGenerationContext {
	readonly sessionId: string;
	readonly generation: number;
}

export interface SessionExecutionClaim {
	readonly kind: "execution";
	readonly context: SessionGenerationContext;
}

export interface SessionTransitionClaim {
	readonly kind: "transition";
	readonly context: SessionGenerationContext;
}

export type SessionOperationState =
	| Readonly<{
		readonly phase: "idle";
		readonly context: SessionGenerationContext;
	}>
	| Readonly<{
		readonly phase: "executing";
		readonly context: SessionGenerationContext;
		readonly claim: SessionExecutionClaim;
	}>
	| Readonly<{
		readonly phase: "transitioning";
		readonly context: SessionGenerationContext;
		readonly claim: SessionTransitionClaim;
	}>;

export interface SessionOperationClaimResult<
	Claim extends SessionExecutionClaim | SessionTransitionClaim,
> {
	readonly state: SessionOperationState;
	readonly claim: Claim;
}

export function createSessionOperationState(
	context: SessionGenerationContext,
): SessionOperationState {
	return idleState(normalizedContext(context));
}

export function sessionOperationContext(
	state: SessionOperationState,
): SessionGenerationContext {
	return state.context;
}

export function isSessionOperationContextCurrent(
	state: SessionOperationState,
	context: SessionGenerationContext,
): boolean {
	return sameContext(state.context, context);
}

export function claimSessionExecution(
	state: SessionOperationState,
	context: SessionGenerationContext,
): SessionOperationClaimResult<SessionExecutionClaim> | undefined {
	if (state.phase !== "idle" || !sameContext(state.context, context)) return undefined;
	const claim = Object.freeze({
		kind: "execution" as const,
		context: state.context,
	});
	return Object.freeze({
		state: Object.freeze({ phase: "executing" as const, context: state.context, claim }),
		claim,
	});
}

export function releaseSessionExecution(
	state: SessionOperationState,
	claim: SessionExecutionClaim,
): SessionOperationState | undefined {
	if (state.phase !== "executing" || state.claim !== claim) return undefined;
	return idleState(state.context);
}

export function beginSessionTransition(
	state: SessionOperationState,
	context: SessionGenerationContext,
): SessionOperationClaimResult<SessionTransitionClaim> | undefined {
	if (state.phase !== "idle" || !sameContext(state.context, context)) return undefined;
	const claim = Object.freeze({
		kind: "transition" as const,
		context: state.context,
	});
	return Object.freeze({
		state: Object.freeze({ phase: "transitioning" as const, context: state.context, claim }),
		claim,
	});
}

export function commitSessionTransition(
	state: SessionOperationState,
	claim: SessionTransitionClaim,
	nextContext: SessionGenerationContext,
): SessionOperationState | undefined {
	if (state.phase !== "transitioning" || state.claim !== claim) return undefined;
	const normalized = normalizedContext(nextContext);
	if (normalized.generation !== state.context.generation + 1) {
		throw new RangeError("session generation must advance exactly once");
	}
	return idleState(normalized);
}

export function abortSessionTransition(
	state: SessionOperationState,
	claim: SessionTransitionClaim,
): SessionOperationState | undefined {
	if (state.phase !== "transitioning" || state.claim !== claim) return undefined;
	return idleState(state.context);
}

function idleState(context: SessionGenerationContext): SessionOperationState {
	return Object.freeze({ phase: "idle" as const, context });
}

function normalizedContext(context: SessionGenerationContext): SessionGenerationContext {
	const sessionId = context.sessionId.trim();
	if (!sessionId || /[\0\r\n]/u.test(sessionId)) {
		throw new TypeError("sessionId must be a non-empty single-line string");
	}
	if (!Number.isSafeInteger(context.generation) || context.generation < 1) {
		throw new TypeError("generation must be a positive safe integer");
	}
	return Object.freeze({ sessionId, generation: context.generation });
}

function sameContext(
	left: SessionGenerationContext,
	right: SessionGenerationContext,
): boolean {
	return left.sessionId === right.sessionId && left.generation === right.generation;
}
