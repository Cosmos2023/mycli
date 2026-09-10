import type {
	AgentSpawnReservation,
	AgentSpawnStore,
	AgentThreadRecord,
	AgentThreadStore,
	ReserveAgentSpawnInput,
} from "./agent-thread-store.ts";
import type {
	CompleteSubagentTaskInput,
	FailSubagentTaskInput,
	InterruptSubagentTaskInput,
	ReserveSubagentTaskInput,
	SubagentTaskOwnership,
	SubagentTaskRecord,
	SubagentTaskStore,
} from "./subagent-task-store.ts";

export type AgentLifecycleFailpoint =
	| "spawn_after_thread"
	| "activate_after_task"
	| "follow_up_after_reservation"
	| "follow_up_after_task"
	| "complete_after_task"
	| "fail_after_task"
	| "interrupt_after_task"
	| "spawn_failure_after_activation"
	| "spawn_failure_after_task";

export interface AgentLifecycleTransition {
	readonly task: SubagentTaskRecord;
	readonly thread: AgentThreadRecord;
}

export interface AgentLifecycleStore extends AgentSpawnStore {
	activate(input: SubagentTaskOwnership): AgentLifecycleTransition;
	startFollowUp(input: ReserveSubagentTaskInput): AgentLifecycleTransition;
	completeRun(input: CompleteSubagentTaskInput): AgentLifecycleTransition;
	failRun(input: FailSubagentTaskInput): AgentLifecycleTransition;
	interruptRun(input: InterruptSubagentTaskInput): AgentLifecycleTransition;
	failSpawn(input: FailSubagentTaskInput): AgentLifecycleTransition;
}

export interface SQLiteAgentLifecycleRepositoryOptions {
	readonly threads: AgentThreadStore;
	readonly tasks: SubagentTaskStore;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly failpoint?: (name: AgentLifecycleFailpoint) => void;
}

export class SQLiteAgentLifecycleRepository implements AgentLifecycleStore {
	readonly #threads: AgentThreadStore;
	readonly #tasks: SubagentTaskStore;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;
	readonly #failpoint: (name: AgentLifecycleFailpoint) => void;

	constructor(options: SQLiteAgentLifecycleRepositoryOptions) {
		this.#threads = options.threads;
		this.#tasks = options.tasks;
		this.#writeTransaction = options.write;
		this.#failpoint = options.failpoint ?? (() => undefined);
	}

	reserve(input: ReserveAgentSpawnInput): AgentSpawnReservation {
		return this.#writeTransaction(() => {
			const thread = this.#threads.reserve(input.thread);
			this.#failpoint("spawn_after_thread");
			const task = this.#tasks.reserve(input.task);
			return transition(task, thread);
		});
	}

	activate(input: SubagentTaskOwnership): AgentLifecycleTransition {
		return this.#writeTransaction(() => {
			const task = this.#tasks.markRunning(input);
			this.#failpoint("activate_after_task");
			const thread = this.#threads.transition({
				threadId: input.childSessionId,
				status: "running",
			});
			return transition(task, thread);
		});
	}

	startFollowUp(input: ReserveSubagentTaskInput): AgentLifecycleTransition {
		return this.#writeTransaction(() => {
			this.#tasks.reserve(input);
			this.#failpoint("follow_up_after_reservation");
			const task = this.#tasks.markRunning(input);
			this.#failpoint("follow_up_after_task");
			const thread = this.#threads.transition({
				threadId: input.childSessionId,
				status: "running",
			});
			return transition(task, thread);
		});
	}

	completeRun(input: CompleteSubagentTaskInput): AgentLifecycleTransition {
		return this.#writeTransaction(() => {
			const task = this.#tasks.complete(input);
			this.#failpoint("complete_after_task");
			const thread = this.#threads.transition({
				threadId: input.childSessionId,
				status: "idle",
			});
			return transition(task, thread);
		});
	}

	failRun(input: FailSubagentTaskInput): AgentLifecycleTransition {
		return this.#writeTransaction(() => {
			const task = this.#tasks.fail(input);
			this.#failpoint("fail_after_task");
			const thread = this.#threads.transition({
				threadId: input.childSessionId,
				status: "failed",
				terminalSummary: input.report || input.error,
			});
			return transition(task, thread);
		});
	}

	interruptRun(input: InterruptSubagentTaskInput): AgentLifecycleTransition {
		return this.#writeTransaction(() => {
			const task = this.#tasks.interrupt(input);
			this.#failpoint("interrupt_after_task");
			const thread = this.#threads.transition({
				threadId: input.childSessionId,
				status: "interrupted",
				terminalSummary: input.report || input.reason,
			});
			return transition(task, thread);
		});
	}

	failSpawn(input: FailSubagentTaskInput): AgentLifecycleTransition {
		return this.#writeTransaction(() => {
			const active = this.activate(input);
			this.#failpoint("spawn_failure_after_activation");
			const task = this.#tasks.fail(input);
			this.#failpoint("spawn_failure_after_task");
			const thread = this.#threads.transition({
				threadId: active.thread.threadId,
				status: "failed",
				terminalSummary: input.report || input.error,
			});
			return transition(task, thread);
		});
	}
}

function transition(
	task: SubagentTaskRecord,
	thread: AgentThreadRecord,
): AgentLifecycleTransition {
	return Object.freeze({ task, thread });
}
