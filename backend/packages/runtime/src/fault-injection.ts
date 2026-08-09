export type RuntimeFailpoint =
	| "queue_before_save"
	| "queue_after_save"
	| "approval_after_resolution"
	| "effect_after_claim"
	| "compaction_after_summary_request"
	| "memory_after_topic_write"
	| "memory_before_index_write"
	| "session_after_prepare"
	| "session_after_commit";

export type RuntimeFailpointHook = (name: RuntimeFailpoint) => void;

export const NO_RUNTIME_FAILPOINT: RuntimeFailpointHook = () => undefined;
