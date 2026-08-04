export type ApprovalResolution =
	| { readonly status: "waiting"; readonly decisionId: string }
	| { readonly status: "rejected"; readonly decisionId: string }
	| { readonly status: "approved"; readonly decisionId: string }
	| {
		readonly status: "executing";
		readonly decisionId: string;
		readonly fingerprint: string;
	}
	| {
		readonly status: "completed";
		readonly decisionId: string;
		readonly fingerprint: string;
		readonly resultCallId: string;
	};

export type ApprovalTransition =
	| { readonly type: "approve_once" }
	| { readonly type: "reject" }
	| { readonly type: "claim_effect"; readonly fingerprint: string }
	| { readonly type: "complete_effect"; readonly resultCallId: string };

export class ApprovalConflictError extends Error {
	readonly code = "approval_conflict" as const;

	constructor(status: ApprovalResolution["status"], action: ApprovalTransition["type"]) {
		super(`approval_conflict: cannot apply ${action} to ${status}`);
		this.name = "ApprovalConflictError";
	}
}

export function createWaitingApproval(decisionId: string): ApprovalResolution {
	return Object.freeze({
		status: "waiting" as const,
		decisionId: nonEmpty(decisionId, "decisionId"),
	});
}

export function transitionApproval(
	state: ApprovalResolution,
	transition: ApprovalTransition,
): ApprovalResolution {
	if (state.status === "waiting") {
		if (transition.type === "approve_once") {
			return Object.freeze({ status: "approved", decisionId: state.decisionId });
		}
		if (transition.type === "reject") {
			return Object.freeze({ status: "rejected", decisionId: state.decisionId });
		}
	}

	if (state.status === "approved") {
		if (transition.type === "approve_once") {
			return state;
		}
		if (transition.type === "claim_effect") {
			return Object.freeze({
				status: "executing",
				decisionId: state.decisionId,
				fingerprint: nonEmpty(transition.fingerprint, "fingerprint"),
			});
		}
	}

	if (state.status === "rejected" && transition.type === "reject") {
		return state;
	}

	if (state.status === "executing") {
		if (transition.type === "claim_effect") {
			if (nonEmpty(transition.fingerprint, "fingerprint") === state.fingerprint) {
				return state;
			}
			throw new ApprovalConflictError(state.status, transition.type);
		}
		if (transition.type === "complete_effect") {
			return Object.freeze({
				status: "completed",
				decisionId: state.decisionId,
				fingerprint: state.fingerprint,
				resultCallId: nonEmpty(transition.resultCallId, "resultCallId"),
			});
		}
	}

	if (state.status === "completed" && transition.type === "complete_effect") {
		if (nonEmpty(transition.resultCallId, "resultCallId") === state.resultCallId) {
			return state;
		}
	}

	throw new ApprovalConflictError(state.status, transition.type);
}

function nonEmpty(value: string, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value.trim();
}
