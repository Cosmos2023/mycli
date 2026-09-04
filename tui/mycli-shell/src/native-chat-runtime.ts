import { createInterface, type Interface } from "node:readline";
import { isSlashCommandSubmission } from "./adapters/slash-commands.ts";
import { renderMycliShell, renderTranscriptBlocks } from "./shell-app.ts";
import type {
	MycliShellCommandSpec,
	MycliShellPendingApproval,
	MycliShellState,
	MycliShellTranscriptBlock,
} from "./model.ts";
import { safeErrorMessage } from "./safe-ui-text.ts";
import { uiGlyphs } from "./theme/terminal-style.ts";
import type { MycliUiAction, MycliUiActionDispatcher } from "./ui-actions.ts";

type NativeChatStreams = {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
};

export type NativeChatRuntimeOptions = {
	initialState: MycliShellState;
	streams?: NativeChatStreams;
	actions?: MycliUiActionDispatcher;
	onSubmit?: (text: string) => void | Promise<void>;
	onApprovalRespond?: (
		decisionId: string,
		choice: string,
		approval: MycliShellPendingApproval,
	) => void | Promise<void>;
	onClarificationRespond?: (requestId: string, response: string) => void | Promise<void>;
	onFollowUp?: (text: string) => void | Promise<void>;
	onCommandSubmit?: (command: string) => void | Promise<void>;
	onInterrupt?: (options: { rollbackUserInput: boolean }) => void | Promise<void>;
	onExit?: () => void | Promise<void>;
	onInterruptExit?: () => void | Promise<void>;
	commands?: MycliShellCommandSpec[];
	commandNames?: string[];
	columns?: () => number;
};

export class NativeChatRuntime {
	private state: MycliShellState;
	private readonly streams: NativeChatStreams;
	private readonly renderedBlockSignatures = new Map<string, string>();
	private readonly columns: () => number;
	private readline: Interface | null = null;
	private started = false;
	private stopping = false;
	private interruptQueued = false;
	private lastPendingNotice: string | null = null;
	private actionQueue: Promise<void> = Promise.resolve();

	constructor(private readonly options: NativeChatRuntimeOptions) {
		this.state = options.initialState;
		if (!options.streams) {
			throw new Error("NativeChatRuntime requires explicit TTY streams.");
		}
		this.streams = options.streams;
		this.columns = options.columns ?? (() => Number((this.streams.output as { columns?: number }).columns) || Number(process.env.COLUMNS) || 100);
	}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.renderInitial();
		this.readline = createInterface({
			input: this.streams.input,
			output: this.streams.output,
			prompt: this.promptText(),
			terminal: true,
		});
		this.readline.on("line", (line) => {
			this.enqueueAction(() => this.handleLine(line));
		});
		this.readline.on("SIGINT", () => {
			if (this.interruptQueued) return;
			this.interruptQueued = true;
			this.enqueueAction(async () => {
				try {
					await this.handleInterrupt();
				} finally {
					this.interruptQueued = false;
				}
			});
		});
		this.readline.on("close", () => {
			this.handleReadlineClose();
		});
		this.readline.prompt();
	}

	setState(nextState: MycliShellState): void {
		const previousPrompt = this.promptText();
		this.state = nextState;
		this.renderChangedTranscriptBlocks();
		this.renderStatusChanges();
		if (this.started && this.readline) {
			const nextPrompt = this.promptText();
			if (nextPrompt !== previousPrompt) {
				this.readline.setPrompt(nextPrompt);
			}
			this.readline.prompt(true);
		}
	}

	isStarted(): boolean {
		return this.started;
	}

	async stop(options: { notifyExit?: boolean } = {}): Promise<void> {
		if (!this.started) {
			return;
		}
		this.stopping = true;
		this.started = false;
		this.readline?.close();
		this.readline = null;
		if (options.notifyExit !== false) {
			await this.dispatch({ type: "exit", reason: "normal" });
		}
		this.stopping = false;
	}

	private async handleInterrupt(): Promise<void> {
		if (this.isTurnRunning()) {
			await this.runAction(
				{ type: "interrupt", rollbackUserInput: false },
				"Interrupt request failed",
			);
			return;
		}
		await this.stop({ notifyExit: false });
		await this.runAction({ type: "exit", reason: "interrupt" }, "Exit failed");
	}

	restoreQueuedText(text: string): void {
		if (!this.readline) {
			return;
		}
		this.readline.write(text);
	}

	private renderInitial(): void {
		const lines = renderMycliShell(this.state, this.columns());
		this.writeLines(lines);
		for (const block of this.transcriptBlocks()) {
			this.renderedBlockSignatures.set(block.id, transcriptBlockSignature(block));
		}
		this.lastPendingNotice = this.state.pendingNotice ?? null;
	}

	private renderChangedTranscriptBlocks(): void {
		const blocks = this.transcriptBlocks();
		const changedIds = new Set<string>();
		const currentIds = new Set<string>();
		for (const block of blocks) {
			currentIds.add(block.id);
			const signature = transcriptBlockSignature(block);
			if (this.renderedBlockSignatures.get(block.id) !== signature) {
				changedIds.add(block.id);
				this.renderedBlockSignatures.set(block.id, signature);
			}
		}
		for (const id of this.renderedBlockSignatures.keys()) {
			if (!currentIds.has(id)) this.renderedBlockSignatures.delete(id);
		}
		if (changedIds.size === 0) {
			return;
		}
		this.writeLines(renderTranscriptBlocks(blocks.filter((block) => changedIds.has(block.id)), this.columns()).filter((line) => line.trim().length > 0));
	}

	private renderStatusChanges(): void {
		const notice = this.state.pendingNotice ?? null;
		if (notice === this.lastPendingNotice) return;
		this.lastPendingNotice = notice;
		if (!notice) return;
		this.writeLines([notice]);
	}

	private transcriptBlocks() {
		return this.state.transcript?.length
			? this.state.transcript
			: [
					...this.state.messages.map((message) => ({ id: message.id, kind: "message" as const, message })),
					...this.state.tools.map((tool) => ({ id: tool.id, kind: "tool" as const, tool })),
					...this.state.bash.map((bash) => ({ id: bash.id, kind: "bash" as const, bash })),
				];
	}

	private async handleLine(line: string): Promise<void> {
		const text = line.trim();
		if (!text) {
			this.readline?.prompt();
			return;
		}
		const commandNames = this.options.commandNames
			?? this.options.commands?.map((command) => command.name)
			?? [];
		if (isSlashCommandSubmission(text, commandNames)) {
			await this.runAction({ type: "command", command: text }, "Command failed");
		} else if (this.state.pendingApproval) {
			const choice = approvalChoice(this.state.pendingApproval, text);
			if (!choice) {
				this.writeLines(["Choose an approval option by number, label, or value."]);
			} else {
				await this.runAction({
					type: "approval.respond",
					approval: this.state.pendingApproval,
					choice,
				}, "Approval response failed");
			}
		} else if (this.state.pendingClarification) {
			await this.runAction({
				type: "clarification.respond",
				clarification: this.state.pendingClarification,
				response: text,
			}, "Clarification response failed");
		} else {
			await this.runAction({ type: "submit", text }, "Message submission failed");
		}
		this.readline?.prompt();
	}

	private enqueueAction(action: () => Promise<void>): void {
		this.actionQueue = this.actionQueue
			.then(action)
			.catch((error) => {
				this.writeLines([safeErrorMessage(error, "Action failed")]);
			});
	}

	private async runAction(action: MycliUiAction, fallback: string): Promise<void> {
		try {
			await this.dispatch(action);
		} catch (error) {
			const detail = safeErrorMessage(error, fallback);
			this.writeLines([detail === fallback ? fallback : `${fallback}: ${detail}`]);
		}
	}

	private async dispatch(action: MycliUiAction): Promise<unknown> {
		if (this.options.actions) return this.options.actions.dispatch(action);
		switch (action.type) {
			case "submit":
				return this.options.onSubmit?.(action.text);
			case "follow_up":
				return this.options.onFollowUp?.(action.text);
			case "command":
				return this.options.onCommandSubmit?.(action.command);
			case "interrupt":
				return this.options.onInterrupt?.({ rollbackUserInput: action.rollbackUserInput });
			case "approval.respond":
				return this.options.onApprovalRespond?.(
					action.approval.decisionId,
					action.choice,
					action.approval,
				);
			case "clarification.respond":
				return this.options.onClarificationRespond?.(
					action.clarification.requestId,
					action.response,
				);
			case "exit":
				return action.reason === "interrupt"
					? this.options.onInterruptExit?.()
					: this.options.onExit?.();
			case "dequeue_queued_input":
				return undefined;
		}
	}

	private handleReadlineClose(): void {
		this.readline = null;
		if (!this.started || this.stopping) return;
		this.started = false;
		this.enqueueAction(async () => {
			await this.runAction({ type: "exit", reason: "normal" }, "Exit failed");
		});
	}

	private isTurnRunning(): boolean {
		return this.state.footer.turnRunning === true
			|| ["running", "interrupting", "waiting_approval", "waiting_clarification"]
				.includes(this.state.footer.liveStateKind?.trim().toLowerCase() ?? "")
			|| ["running", "interrupting", "waiting approval", "waiting clarification"]
				.includes(this.state.footer.liveState?.trim().toLowerCase() ?? "");
	}

	private promptText(): string {
		const live = this.state.footer.liveState && this.state.footer.liveState !== "Idle" ? ` ${this.state.footer.liveState}` : "";
		return `\n${uiGlyphs().prompt} Message mycli${live}  `;
	}

	private writeLines(lines: string[]): void {
		if (lines.length === 0) {
			return;
		}
		this.streams.output.write(`${lines.join("\n")}\n`);
	}
}

function approvalChoice(approval: MycliShellPendingApproval, input: string): string | null {
	const numeric = Number(input);
	if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= approval.options.length) {
		return approval.options[numeric - 1]?.choice ?? null;
	}
	const normalized = input.trim().toLowerCase();
	const option = approval.options.find((candidate) =>
		candidate.choice.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized);
	return option?.choice ?? null;
}

function transcriptBlockSignature(block: MycliShellTranscriptBlock): string {
	return JSON.stringify(block);
}
