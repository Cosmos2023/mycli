import { createInterface, type Interface } from "node:readline";
import { isSlashCommandSubmission } from "./adapters/slash-commands.ts";
import { renderMycliShell, renderTranscriptBlocks } from "./shell-app.ts";
import type { MycliShellCommandSpec, MycliShellState } from "./model.ts";
import { uiGlyphs } from "./theme/terminal-style.ts";

type NativeChatStreams = {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
};

export type NativeChatRuntimeOptions = {
	initialState: MycliShellState;
	streams?: NativeChatStreams;
	onSubmit?: (text: string) => void | Promise<void>;
	onClarificationRespond?: (requestId: string, response: string) => void | Promise<void>;
	onFollowUp?: (text: string) => void | Promise<void>;
	onCommandSubmit?: (command: string) => void | Promise<void>;
	onExit?: () => void | Promise<void>;
	onInterruptExit?: () => void | Promise<void>;
	commands?: MycliShellCommandSpec[];
	commandNames?: string[];
	columns?: () => number;
};

export class NativeChatRuntime {
	private state: MycliShellState;
	private readonly streams: NativeChatStreams;
	private readonly seenBlockIds = new Set<string>();
	private readonly columns: () => number;
	private readline: Interface | null = null;
	private started = false;

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
			void this.handleLine(line);
		});
		this.readline.on("SIGINT", () => {
			void this.handleInterruptExit();
		});
		this.readline.prompt();
	}

	setState(nextState: MycliShellState): void {
		const previousPrompt = this.promptText();
		this.state = nextState;
		this.renderNewTranscriptBlocks();
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
		this.started = false;
		this.readline?.close();
		this.readline = null;
		if (options.notifyExit !== false) {
			await this.options.onExit?.();
		}
	}

	private async handleInterruptExit(): Promise<void> {
		await this.stop({ notifyExit: false });
		await this.options.onInterruptExit?.();
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
			this.seenBlockIds.add(block.id);
		}
	}

	private renderNewTranscriptBlocks(): void {
		const blocks = this.transcriptBlocks();
		const unseenIds = new Set<string>();
		for (const block of blocks) {
			if (!this.seenBlockIds.has(block.id)) {
				unseenIds.add(block.id);
				this.seenBlockIds.add(block.id);
			}
		}
		if (unseenIds.size === 0) {
			return;
		}
		this.writeLines(renderTranscriptBlocks(blocks.filter((block) => unseenIds.has(block.id)), this.columns()).filter((line) => line.trim().length > 0));
	}

	private renderStatusChanges(): void {
		const notice = this.state.pendingNotice;
		if (!notice) {
			return;
		}
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
			await this.options.onCommandSubmit?.(text);
		} else if (this.state.pendingClarification) {
			await this.options.onClarificationRespond?.(
				this.state.pendingClarification.requestId,
				text,
			);
		} else {
			await this.options.onSubmit?.(text);
		}
		this.readline?.prompt();
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
