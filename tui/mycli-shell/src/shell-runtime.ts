import { spawnSync } from "node:child_process";
import { SelectList, type SelectItem } from "./tui-core/components/select-list.ts";
import { Spacer } from "./tui-core/components/spacer.ts";
import { Text } from "./tui-core/components/text.ts";
import { ProcessTerminal, type Terminal } from "./tui-core/terminal.ts";
import { Container, TUI, type Component } from "./tui-core/tui.ts";
import { matchesKey } from "./tui-core/keys.ts";
import { CombinedAutocompleteProvider, type SlashCommand } from "./tui-core/autocomplete.ts";
import { installMycliKeybindings } from "./keybindings.ts";
import type {
	MycliShellAuthProvider,
	MycliShellCommand,
	MycliShellMessage,
	MycliShellModel,
	MycliShellPendingApproval,
	MycliShellResource,
	MycliShellSessionTree,
	MycliShellSessionTreeNode,
	MycliShellState,
	MycliShellSubagent,
	MycliShellTranscriptBlock,
	MycliShellVisualSettings,
} from "./model.ts";
import { ApprovalSelectorComponent } from "./components/approval-selector.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { CollapsedToolGroupComponent } from "./components/collapsed-tool-group.ts";
import { CommandDiagnosticComponent } from "./components/command-diagnostic.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { FooterComponent } from "./components/footer.ts";
import { rawKeyHint } from "./components/keybinding-hints.ts";
import { LoginFlowComponent } from "./components/login-flow.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { PlanPanelComponent } from "./components/plan-panel.ts";
import { ProposedPlanComponent } from "./components/proposed-plan.ts";
import { ResourceSelectorComponent } from "./components/resource-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SessionTreeSelectorComponent } from "./components/session-tree-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SubagentExecutionComponent, SubagentGroupComponent } from "./components/subagent-execution.ts";
import { BackgroundSubagentDialogComponent, isResolvedSubagent, SubagentTaskPanelComponent } from "./components/subagent-task-panel.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { TrustSelectorComponent, type ProjectTrustDecision } from "./components/trust-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { getEditorTheme, getSelectListTheme, theme } from "./theme/theme.ts";
import { projectTranscriptBlocks, type ProjectedTranscriptBlock } from "./transcript-projection.ts";

export type MycliShellRuntimeOptions = {
	initialState: MycliShellState;
	terminal?: Terminal;
	requireTrust?: boolean;
	trustSavedDecision?: ProjectTrustDecision;
	projectTrusted?: boolean;
	onSubmit?: (text: string) => void | Promise<void>;
	onFollowUp?: (text: string) => void | Promise<void>;
	onInterrupt?: () => void | Promise<void>;
	onDequeueQueuedInput?: () => string | null | Promise<string | null>;
	onCommandSubmit?: (command: string) => void | Promise<void>;
	onExit?: () => void | Promise<void>;
	onModelSelect?: (model: MycliShellModel) => void | Promise<void>;
	onApiKeyLogin?: (providerId: string, apiKey: string) => void | { message?: string } | Promise<void | { message?: string }>;
	onSessionSelect?: (sessionId: string) => void | Promise<void>;
	onSessionTreeLoad?: () => MycliShellSessionTree | Promise<MycliShellSessionTree>;
	onSessionTreeSelect?: (node: MycliShellSessionTreeNode) => void | Promise<void>;
	onSettingsChange?: (settings: MycliShellVisualSettings) => MycliShellVisualSettings | Promise<MycliShellVisualSettings>;
	onResourceLoad?: () => MycliShellResource[] | Promise<MycliShellResource[]>;
	onApprovalRespond?: (decisionId: string, choice: string) => void | Promise<void>;
	commands?: MycliShellCommand[];
	now?: () => number;
};

const BACKEND_COMMANDS: MycliShellCommand[] = [
	{ id: "status", label: "/status", description: "Inspect runtime status", run: () => undefined },
	{ id: "status-usage", label: "/status usage", description: "Inspect token usage", run: () => undefined },
	{ id: "status-context", label: "/status context", description: "Inspect context window diagnostics", run: () => undefined },
	{ id: "status-stats", label: "/status stats", description: "Inspect aggregate runtime stats", run: () => undefined },
	{ id: "session-list", label: "/session list", description: "List resumable sessions", run: () => undefined },
	{ id: "session-search", label: "/session search", description: "Search saved sessions", run: () => undefined },
	{ id: "session-fork", label: "/session fork", description: "Fork a saved session", run: () => undefined },
	{ id: "plan", label: "/plan", description: "Switch to Plan mode", run: () => undefined },
	{ id: "mode", label: "/mode", description: "Inspect or switch collaboration mode", run: () => undefined },
	{ id: "sandbox", label: "/sandbox", description: "Inspect sandbox permissions", run: () => undefined },
	{ id: "sandbox-next", label: "/sandbox next", description: "Cycle sandbox permissions", run: () => undefined },
	{ id: "agents", label: "/agents", description: "Manage agent profiles", run: () => undefined },
	{ id: "agents-list", label: "/agents list", description: "List agent profiles", run: () => undefined },
	{ id: "agents-runs", label: "/agents runs", description: "Inspect agent runs", run: () => undefined },
	{ id: "agents-kill", label: "/agents kill", description: "Stop background agents", run: () => undefined },
	{ id: "tasks", label: "/tasks", description: "Inspect background tasks", run: () => undefined },
	{ id: "tasks-agents", label: "/tasks agents", description: "Inspect background agents", run: () => undefined },
	{ id: "tasks-bashes", label: "/tasks bashes", description: "Inspect background shells", run: () => undefined },
	{ id: "tasks-agents-kill", label: "/tasks agents kill", description: "Stop a background agent", run: () => undefined },
	{ id: "tasks-kill-agents", label: "/tasks kill-agents", description: "Stop background agents", run: () => undefined },
	{ id: "tools", label: "/tools", description: "Inspect backend tools", run: () => undefined },
	{ id: "tools-permissions", label: "/tools permissions", description: "Inspect approvals and command allowances", run: () => undefined },
	{ id: "permissions", label: "/permissions", description: "Inspect permission allowlist", run: () => undefined },
	{ id: "permissions-allow", label: "/permissions allow", description: "Allow a shell command pattern for this session", run: () => undefined },
	{ id: "permissions-revoke", label: "/permissions revoke", description: "Remove a session command allowance", run: () => undefined },
	{ id: "permissions-clear", label: "/permissions clear", description: "Clear session command allowances", run: () => undefined },
	{ id: "tools-sets", label: "/tools sets", description: "Inspect backend toolsets", run: () => undefined },
	{ id: "tools-hooks", label: "/tools hooks", description: "Inspect configured hooks", run: () => undefined },
	{ id: "tools-extensions", label: "/tools extensions", description: "Inspect extension runtime", run: () => undefined },
	{ id: "tools-plugins", label: "/tools plugins", description: "Inspect or run plugin commands", run: () => undefined },
	{ id: "tools-skills", label: "/tools skills", description: "Inspect available skills", run: () => undefined },
	{ id: "skills", label: "/skills", description: "Inspect available skills", run: () => undefined },
	{ id: "resources", label: "/resources", description: "Browse runtime resources", run: () => undefined },
	{ id: "memory", label: "/memory", description: "Inspect session memory", run: () => undefined },
	{ id: "changes", label: "/changes", description: "Inspect file changes", run: () => undefined },
	{ id: "changes-undo", label: "/changes undo", description: "Undo last recoverable file change", run: () => undefined },
	{ id: "trace", label: "/trace", description: "Inspect runtime trace", run: () => undefined },
	{ id: "trace-export", label: "/trace export", description: "Export runtime trace JSONL", run: () => undefined },
	{ id: "trace-logs", label: "/trace logs", description: "Inspect workspace logs", run: () => undefined },
	{ id: "session-maintenance", label: "/session maintenance", description: "Inspect session storage maintenance", run: () => undefined },
];

type ChatBlockComponent =
	| { kind: "message"; signature: string; role: MycliShellMessage["role"]; component: Component }
	| { kind: "plan"; signature: string; component: ProposedPlanComponent }
	| { kind: "tool"; signature: string; component: ToolExecutionComponent }
	| { kind: "bash"; signature: string; component: BashExecutionComponent }
	| { kind: "subagent"; signature: string; component: SubagentExecutionComponent }
	| { kind: "diagnostic"; signature: string; component: CommandDiagnosticComponent }
	| { kind: "agent_group"; signature: string; component: SubagentGroupComponent }
	| { kind: "tool_group"; signature: string; component: CollapsedToolGroupComponent };

class TurnActivityComponent implements Component {
	private readonly frames = ["◐", "◓", "◑", "◒"];
	private frameIndex = 0;
	private intervalId: NodeJS.Timeout | null = null;

	constructor(
		private readonly ui: TUI,
		private readonly startedAtMs: number,
		private readonly now: () => number,
	) {
		this.start();
	}

	stop(): void {
		if (!this.intervalId) {
			return;
		}
		clearInterval(this.intervalId);
		this.intervalId = null;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const elapsedSeconds = elapsedSecondsFor(this.now() - this.startedAtMs);
		const frame = this.frames[this.frameIndex] ?? this.frames[0] ?? "";
		return new Text(`${theme.fg("accent", frame)} ${theme.fg("muted", `(Thinking... ${elapsedSeconds} s)`)}`, 1, 0).render(width);
	}

	private start(): void {
		if (this.intervalId) {
			return;
		}
		this.intervalId = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.ui.requestRender();
		}, 250);
		this.intervalId.unref?.();
	}
}

class TurnCompletedComponent implements Component {
	constructor(private readonly durationMs: number) {}

	invalidate(): void {}

	render(width: number): string[] {
		return new Text(theme.fg("muted", `✻ Completed for ${elapsedSecondsFor(this.durationMs)} s`), 1, 0).render(width);
	}
}

class TranscriptViewportComponent implements Component {
	private scrollOffset = 0;
	private lastLineCount = 0;
	private renderFullOnce = false;

	constructor(
		private readonly content: Container,
		private readonly heightForWidth: (width: number) => number,
	) {}

	getScrollOffset(): number {
		return this.scrollOffset;
	}

	scrollBy(deltaLines: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + deltaLines);
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
	}

	scrollToLine(lineIndex: number, width: number): void {
		const lines = this.content.render(width);
		const height = Math.max(1, this.heightForWidth(width));
		this.lastLineCount = lines.length;
		const target = Math.max(0, Math.min(lineIndex, Math.max(0, lines.length - 1)));
		this.scrollOffset = Math.max(0, lines.length - height - target);
	}

	renderFullNext(): void {
		this.renderFullOnce = true;
	}

	invalidate(): void {
		this.content.invalidate();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.heightForWidth(width));
		const lines = this.content.render(width);
		if (lines.length > this.lastLineCount) {
			this.scrollOffset = 0;
		}
		this.lastLineCount = lines.length;
		if (this.renderFullOnce) {
			this.scrollOffset = 0;
			return lines;
		}
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, lines.length - height));

		const start = Math.max(0, lines.length - height - this.scrollOffset);
		const visible = lines.slice(start, start + height);
		while (visible.length < height) {
			visible.push("");
		}
		return visible;
	}
}

export class MycliShellRuntime {
	readonly ui: TUI;
	readonly headerContainer = new Container();
	readonly chatContainer = new Container();
	readonly transcriptViewport: TranscriptViewportComponent;
	readonly pendingMessagesContainer = new Container();
	readonly statusContainer = new Container();
	readonly editorContainer = new Container();
	readonly subagentTaskContainer = new Container();
	readonly footerContainer = new Container();
	readonly editor: CustomEditor;

	private state: MycliShellState;
	private started = false;
	private mainMounted = false;
	private chatBlocks = new Map<string, ChatBlockComponent>();
	private turnActivity: TurnActivityComponent | null = null;
	private turnStartedAtMs: number | null = null;
	private completedDurationMs: number | null = null;
	private selectorActive = false;
	private approvalSurfaceDecisionId: string | null = null;
	private readonly now: () => number;
	private lastCtrlCAtMs: number | null = null;
	private lastSubmittedInput: string | null = null;
	private dismissedSubagentIds = new Set<string>();

	constructor(private readonly options: MycliShellRuntimeOptions) {
		this.state = options.initialState;
		this.now = options.now ?? Date.now;
		this.ui = new TUI(options.terminal ?? new ProcessTerminal());
		this.transcriptViewport = new TranscriptViewportComponent(this.chatContainer, (width) => this.transcriptHeight(width));
		if (this.ui.terminal.nativeScrollback) {
			this.transcriptViewport.renderFullNext();
		}
		const keybindings = installMycliKeybindings();
		this.editor = new CustomEditor(this.ui, getEditorTheme(), keybindings, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.refreshAutocompleteProvider();
		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
		this.editor.onEscape = () => {
			void this.handleInterrupt();
		};
		this.editor.onAction("app.interrupt", () => {
			void this.handleInterrupt();
		});
		this.editor.onAction("app.exit", () => {
			void this.shutdown();
		});
		this.editor.onAction("app.commandPalette", () => this.showCommandPalette());
		this.editor.onAction("app.help", () => this.showCommandPalette());
		this.editor.onAction("app.model.select", () => this.showModelSelector());
		this.editor.onAction("app.mode.cycle", () => {
			void this.cycleCollaborationMode();
		});
		this.editor.onAction("app.sandbox.cycle", () => {
			void this.cycleSandboxMode();
		});
		this.editor.onAction("app.message.followUp", () => {
			void this.submitFollowUp();
		});
		this.editor.onAction("app.message.dequeue", () => {
			void this.restoreQueuedInput();
		});
		this.editor.onAction("app.tools.expand", () => this.toggleToolDetails());
		this.ui.addInputListener((data) => this.handleGlobalInput(data));
		this.editorContainer.addChild(this.editor);
		if (!options.requireTrust) {
			this.mountMain();
			this.rebuildAll();
		}
	}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.ui.start();
		if (this.options.requireTrust) {
			this.showTrustGate();
		} else if (!this.selectorActive) {
			this.ui.setFocus(this.editor);
		}
	}

	setState(nextState: MycliShellState): void {
		const previousState = this.state;
		this.updateStatusTiming(previousState, nextState);
		this.state = nextState;
		if (this.mainMounted) {
			this.rebuildChangedSections(previousState, nextState);
		}
		this.maybeResetTranscriptScroll(previousState, nextState);
		this.ui.requestRender();
	}

	getState(): MycliShellState {
		return this.state;
	}

	isStarted(): boolean {
		return this.started;
	}

	getTranscriptScrollOffset(): number {
		return this.transcriptViewport.getScrollOffset();
	}

	jumpToTranscriptBlock(blockId: string): boolean {
		const lineIndex = this.lineIndexForTranscriptBlock(blockId);
		if (lineIndex === null) {
			return false;
		}
		this.transcriptViewport.scrollToLine(lineIndex, this.ui.terminal.columns);
		this.ui.requestRender();
		return true;
	}

	restoreQueuedText(text: string): void {
		this.restoreQueuedTextToEditor(text);
	}

	async shutdown(): Promise<void> {
		this.stopTurnActivity();
		if (this.started) {
			this.ui.stop();
			this.started = false;
		}
		await this.options.onExit?.();
	}

	refreshTurnStatus(): void {
		this.rebuildChat();
		this.ui.requestRender();
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (this.ui.hasOverlay() || this.selectorActive) {
			return undefined;
		}
		if (matchesKey(data, "ctrl+c")) {
			void this.handleCtrlC();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && this.isTurnRunning()) {
			void this.handleInterrupt();
			return { consume: true };
		}
		if (data === "\x1b[5~") {
			this.scrollTranscript(Math.max(5, this.transcriptPageSize()));
			return { consume: true };
		}
		if (data === "\x1b[6~") {
			this.scrollTranscript(-Math.max(5, this.transcriptPageSize()));
			return { consume: true };
		}
		if (data === "\x1b[A" && this.editor.getText().length === 0) {
			this.scrollTranscript(3);
			return { consume: true };
		}
		if (data === "\x1b[B" && this.editor.getText().length === 0) {
			this.scrollTranscript(-3);
			return { consume: true };
		}
		const mouse = data.match(/^\x1b\[<(\d+);\d+;\d+M$/);
		if (mouse) {
			const button = Number.parseInt(mouse[1] ?? "", 10);
			if (button === 64) {
				this.scrollTranscript(3);
				return { consume: true };
			}
			if (button === 65) {
				this.scrollTranscript(-3);
				return { consume: true };
			}
		}
		return undefined;
	}

	private scrollTranscript(deltaLines: number): void {
		this.transcriptViewport.scrollBy(deltaLines);
		this.ui.requestRender();
	}

	private transcriptPageSize(): number {
		return Math.max(1, this.transcriptHeight(this.ui.terminal.columns) - 1);
	}

	private transcriptHeight(width: number): number {
		if (!this.mainMounted) {
			return this.ui.terminal.rows;
		}
		const chromeHeight =
			this.headerContainer.render(width).length +
			this.pendingMessagesContainer.render(width).length +
			this.statusContainer.render(width).length +
			this.editorContainer.render(width).length +
			this.subagentTaskContainer.render(width).length +
			this.footerContainer.render(width).length;
		return Math.max(1, this.ui.terminal.rows - chromeHeight);
	}

	private resetTranscriptScroll(): void {
		if (this.transcriptViewport.getScrollOffset() === 0) {
			return;
		}
		this.transcriptViewport.scrollToBottom();
	}

	private isTranscriptGrowth(previousState: MycliShellState, nextState: MycliShellState): boolean {
		return this.transcriptLineageLength(nextState) > this.transcriptLineageLength(previousState);
	}

	private transcriptLineageLength(state: MycliShellState): number {
		if (state.transcript?.length) {
			return state.transcript.length;
		}
		return state.messages.length + state.tools.length + state.bash.length;
	}

	private maybeResetTranscriptScroll(previousState: MycliShellState, nextState: MycliShellState): void {
		if (this.isTranscriptGrowth(previousState, nextState)) {
			this.resetTranscriptScroll();
		}
	}

	showTrustGate(): void {
		this.ensureSelectorHostMounted();
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd: this.state.footer.cwd,
				savedDecision: this.options.trustSavedDecision ?? null,
				projectTrusted: this.options.projectTrusted ?? false,
				onSelect: (trusted) => {
					if (trusted) {
						done();
						this.mountMain();
						this.patchFooter({ trust: "trusted" });
						this.ui.setFocus(this.editor);
						return;
					}
					void this.shutdown();
				},
				onCancel: () => {
					void this.shutdown();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	showCommandPalette(): void {
		const commands = this.commands();
		this.showSelector((done) => {
			const list = new SelectList(
				commands.map((command) => ({
					value: command.id,
					label: command.label,
					description: command.description,
				})),
				Math.min(10, Math.max(4, commands.length)),
				getSelectListTheme(),
				{ minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 28 },
			);
			list.onSelect = (item: SelectItem) => {
				done();
				const command = commands.find((candidate) => candidate.id === item.value);
				void command?.run();
			};
			list.onCancel = () => done();
			return { component: list, focus: list };
		});
	}

	showModelSelector(initialSearchInput?: string): void {
		const models = this.state.models ?? [];
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent({
				tui: this.ui,
				currentModel: this.state.currentModel,
				models,
				initialSearchInput,
				onSelect: (model) => {
					done();
					void this.selectModel(model);
				},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	showLoginFlow(): void {
		this.showSelector((done) => {
			const selector = new LoginFlowComponent({
				tui: this.ui,
				providers: this.authProviders(),
				onSubmit: ({ providerId, apiKey }) => {
					void this.submitApiKeyLogin(providerId, apiKey, done);
				},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(this.state.settings, {
				onChange: (settings) => {
					void this.applySettingsChange(settings);
				},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent({
				tui: this.ui,
				sessions: this.state.sessions ?? [],
				currentWorkspace: this.state.footer.cwd,
				onSelect: (session) => {
					done();
					void this.selectSession(session.id);
				},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	async showSessionTreeSelector(): Promise<void> {
		if (!this.options.onSessionTreeLoad) {
			this.addSystemNotice("Session tree is not available in this runtime.");
			return;
		}
		const tree = await this.options.onSessionTreeLoad();
		this.showSelector((done) => {
			const selector = new SessionTreeSelectorComponent({
				tui: this.ui,
				tree,
				onSelect: (node) => {
					done();
					const jumpTarget = this.sessionTreeJumpTarget(node);
					const jumped = jumpTarget !== null;
					this.addSystemNotice(`${jumped ? "Jumped to" : "Selected"} ${node.summary}`);
					if (jumpTarget !== null) {
						this.jumpToTranscriptBlock(jumpTarget);
					}
					void this.options.onSessionTreeSelect?.(node);
				},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	async showResourceSelector(): Promise<void> {
		const resources = this.options.onResourceLoad ? await this.options.onResourceLoad() : (this.state.resources ?? []);
		this.showSelector((done) => {
			const selector = new ResourceSelectorComponent({
				tui: this.ui,
				resources,
				onSelect: (resource) => {
					done();
					void this.inspectResource(resource);
				},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	showBackgroundSubagents(initialDetailSubagentId?: string): void {
		const agents = this.visibleSubagents();
		this.showSelector((done) => {
			const selector = new BackgroundSubagentDialogComponent({
				tui: this.ui,
				agents,
				initialDetailSubagentId,
				onBack: () => done(),
				onClear: (agent) => {
					this.dismissedSubagentIds.add(agent.id);
					this.rebuildSubagentTasks();
				},
				onStop: (agent) => {
					const childSessionId = agent.childSessionId ?? agent.id;
					this.addSystemNotice(`Stopping @${agent.role} (${childSessionId}).`);
					void this.submitCommand(`/tasks agents kill ${childSessionId}`);
				},
				onForeground: (agent) => {
					this.addSystemNotice(`Viewing @${agent.role}.`);
					done();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private mountMain(): void {
		if (this.mainMounted && this.ui.children.length > 2) {
			return;
		}
		this.replaceSelectorHostWithMain();
		this.mainMounted = true;
		this.ui.addChild(this.headerContainer);
		this.ui.addChild(this.transcriptViewport);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.subagentTaskContainer);
		this.ui.addChild(this.footerContainer);
		this.rebuildAll();
	}

	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.restoreEditor();
		};
		const { component, focus } = create(done);
		this.selectorActive = true;
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private restoreEditor(): void {
		this.selectorActive = false;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private ensureSelectorHostMounted(): void {
		if (this.mainMounted) {
			return;
		}
		this.mainMounted = true;
		this.ui.addChild(this.editorContainer);
	}

	private replaceSelectorHostWithMain(): void {
		if (
			this.ui.children.length === 1 &&
			this.ui.children[0] === this.editorContainer
		) {
			this.ui.clear();
			this.mainMounted = false;
		}
	}

	private rebuildAll(): void {
		this.rebuildHeader();
		this.rebuildChat();
		this.rebuildPending();
		this.rebuildStatus();
		this.rebuildSubagentTasks();
		this.rebuildFooter();
		this.syncApprovalSurface(null, this.state);
	}

	private rebuildChangedSections(previousState: MycliShellState, nextState: MycliShellState): void {
		if ((previousState.title ?? "mycli") !== (nextState.title ?? "mycli")) {
			this.rebuildHeader();
		}
		if (this.chatSignature(previousState) !== this.chatSignature(nextState) || this.liveStateSignature(previousState) !== this.liveStateSignature(nextState)) {
			this.rebuildChat();
		}
		if (
			previousState.pendingNotice !== nextState.pendingNotice ||
			this.approvalSignature(previousState) !== this.approvalSignature(nextState) ||
			this.activePlanSignature(previousState) !== this.activePlanSignature(nextState)
		) {
			this.rebuildPending();
		}
		if (previousState.footer.liveState !== nextState.footer.liveState) {
			this.rebuildStatus();
		}
		if (this.subagentTaskSignature(previousState) !== this.subagentTaskSignature(nextState)) {
			this.rebuildSubagentTasks();
		}
		if (this.footerSignature(previousState) !== this.footerSignature(nextState)) {
			this.rebuildFooter();
		}
		this.syncApprovalSurface(previousState, nextState);
	}

	private chatSignature(state: MycliShellState): string {
		return JSON.stringify({
			messages: state.messages,
			tools: state.tools,
			bash: state.bash,
			transcript: state.transcript,
		});
	}

	private liveStateSignature(state: MycliShellState): string {
		return JSON.stringify({
			liveState: state.footer.liveState,
			turnStartedAtMs: this.turnStartedAtMs,
			completedDurationMs: this.completedDurationMs,
		});
	}

	private footerSignature(state: MycliShellState): string {
		return JSON.stringify(state.footer);
	}

	private activePlanSignature(state: MycliShellState): string {
		return JSON.stringify(state.activePlan ?? []);
	}

	private approvalSignature(state: MycliShellState): string {
		return JSON.stringify(state.pendingApproval ?? null);
	}

	private subagentTaskSignature(state: MycliShellState): string {
		return JSON.stringify({
			transcript: state.transcript?.filter((block) => block.kind === "subagent") ?? [],
			dismissed: [...this.dismissedSubagentIds].sort(),
		});
	}

	private syncApprovalSurface(previousState: MycliShellState | null, nextState: MycliShellState): void {
		if (previousState && this.approvalSignature(previousState) === this.approvalSignature(nextState)) {
			return;
		}
		if (!nextState.pendingApproval) {
			if (this.approvalSurfaceDecisionId !== null) {
				this.approvalSurfaceDecisionId = null;
				this.restoreEditor();
			}
			return;
		}
		this.showApprovalSelector(nextState.pendingApproval);
	}

	private showApprovalSelector(approval: MycliShellPendingApproval): void {
		const selector = new ApprovalSelectorComponent({
			approval,
			onSelect: (choice) => {
				void this.respondApproval(approval.decisionId, choice);
			},
			onCancel: () => {
				this.addSystemNotice("Approval still pending.");
			},
		});
		this.approvalSurfaceDecisionId = approval.decisionId;
		this.selectorActive = true;
		this.editorContainer.clear();
		this.editorContainer.addChild(selector);
		this.ui.setFocus(selector);
	}

	private async respondApproval(decisionId: string, choice: string): Promise<void> {
		try {
			await this.options.onApprovalRespond?.(decisionId, choice);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unable to submit approval response.";
			this.addSystemNotice(message);
		}
	}

	private rebuildHeader(): void {
		this.headerContainer.clear();
		const title = this.state.title ?? "mycli";
		const shortcuts = [
			rawKeyHint("ctrl+p", "commands"),
			rawKeyHint("?", "help"),
			rawKeyHint("ctrl+o", "tools"),
			rawKeyHint("ctrl+d", "exit"),
		].join(theme.fg("muted", " · "));
		this.headerContainer.addChild(new Text(`${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", shortcuts)}`, 0, 0));
		this.headerContainer.addChild(new Spacer(1));
	}

	private rebuildChat(): void {
		const transcript = this.state.transcript?.length ? this.state.transcript : this.legacyTranscriptBlocks();
		if (transcript.length > 0) {
			this.syncChatBlocks(transcript);
			return;
		}
		this.chatBlocks.clear();
		this.chatContainer.clear();
	}

	private legacyTranscriptBlocks(): MycliShellTranscriptBlock[] {
		const blocks: MycliShellTranscriptBlock[] = [];
		for (const message of this.state.messages) {
			blocks.push({ id: message.id, kind: "message", message });
		}
		for (const tool of this.state.tools) {
			blocks.push({ id: tool.id, kind: "tool", tool });
		}
		for (const bash of this.state.bash) {
			blocks.push({ id: bash.id, kind: "bash", bash });
		}
		return blocks;
	}

	private syncChatBlocks(blocks: MycliShellTranscriptBlock[]): void {
		this.stopTurnActivity();
		const nextBlocks = new Map<string, ChatBlockComponent>();
		const children: Component[] = [];
		for (const block of projectTranscriptBlocks(blocks)) {
			const cached = this.chatBlocks.get(block.id);
			const next = this.syncChatBlock(block, cached);
			nextBlocks.set(block.id, next);
			children.push(next.component);
		}
		const turnStatus = this.createTurnStatusComponent();
		if (turnStatus) {
			children.push(turnStatus);
		}
		this.chatBlocks = nextBlocks;
		this.chatContainer.children = children;
	}

	private sessionTreeJumpTarget(node: MycliShellSessionTreeNode): string | null {
		if (node.anchorId && this.hasTranscriptBlock(node.anchorId)) {
			return node.anchorId;
		}
		if (node.messageIndex !== undefined) {
			const block = this.messageTranscriptBlockAt(node.messageIndex);
			return block?.id ?? null;
		}
		return null;
	}

	private hasTranscriptBlock(blockId: string): boolean {
		return this.chatBlocks.has(blockId);
	}

	private messageTranscriptBlockAt(index: number): MycliShellTranscriptBlock | null {
		const transcript = this.state.transcript?.length ? this.state.transcript : this.legacyTranscriptBlocks();
		const messages = transcript.filter((block) => block.kind === "message");
		return messages[index] ?? null;
	}

	private lineIndexForTranscriptBlock(blockId: string): number | null {
		let lineIndex = 0;
		for (const child of this.chatContainer.children) {
			const matched = this.chatBlocks.get(blockId);
			if (matched?.component === child) {
				return lineIndex;
			}
			lineIndex += child.render(this.ui.terminal.columns).length;
		}
		return null;
	}

	private createTurnStatusComponent(): Component | null {
		if (this.isRunningLiveState(this.state.footer.liveState)) {
			const startedAtMs = this.turnStartedAtMs ?? this.now();
			this.turnStartedAtMs = startedAtMs;
			this.turnActivity = new TurnActivityComponent(this.ui, startedAtMs, this.now);
			return this.turnActivity;
		}
		if (this.isCompletedLiveState(this.state.footer.liveState)) {
			return new TurnCompletedComponent(this.completedDurationMs ?? 0);
		}
		return null;
	}

	private syncChatBlock(block: ProjectedTranscriptBlock, cached?: ChatBlockComponent): ChatBlockComponent {
		const signature = this.blockSignature(block);
		if (cached?.kind === block.kind) {
			if (block.kind === "tool" && cached.component instanceof ToolExecutionComponent) {
				cached.component.updateTool(block.tool);
				cached.signature = signature;
				return cached;
			}
			if (block.kind === "bash" && cached.component instanceof BashExecutionComponent) {
				cached.component.updateBash(block.bash);
				cached.signature = signature;
				return cached;
			}
			if (block.kind === "tool_group" && cached.component instanceof CollapsedToolGroupComponent) {
				cached.component.updateGroup(block.group);
				cached.signature = signature;
				return cached;
			}
			if (block.kind === "subagent" && cached.component instanceof SubagentExecutionComponent) {
				cached.component.updateSubagent(block.subagent);
				cached.signature = signature;
				return cached;
			}
			if (block.kind === "agent_group" && cached.component instanceof SubagentGroupComponent) {
				cached.component.updateGroup(block.group);
				cached.signature = signature;
				return cached;
			}
			if (block.kind === "message" && cached.kind === "message" && cached.signature === signature) {
				return cached;
			}
			if (
				block.kind === "message" &&
				block.message.role === "assistant" &&
				cached.kind === "message" &&
				cached.role === "assistant" &&
				cached.component instanceof AssistantMessageComponent
			) {
				cached.component.updateMessage(block.message.text, block.message.thinking, block.message.thinkingHidden ?? true);
				cached.signature = signature;
				return cached;
			}
		}
		if (block.kind === "tool") {
			return { kind: "tool", signature, component: new ToolExecutionComponent(block.tool) };
		}
		if (block.kind === "bash") {
			return { kind: "bash", signature, component: new BashExecutionComponent(block.bash) };
		}
		if (block.kind === "plan") {
			return { kind: "plan", signature, component: new ProposedPlanComponent(block.plan) };
		}
		if (block.kind === "tool_group") {
			return { kind: "tool_group", signature, component: new CollapsedToolGroupComponent(block.group) };
		}
		if (block.kind === "subagent") {
			return { kind: "subagent", signature, component: new SubagentExecutionComponent(block.subagent) };
		}
		if (block.kind === "diagnostic") {
			return { kind: "diagnostic", signature, component: new CommandDiagnosticComponent(block.diagnostic) };
		}
		if (block.kind === "agent_group") {
			return { kind: "agent_group", signature, component: new SubagentGroupComponent(block.group) };
		}
		return { kind: "message", signature, role: block.message.role, component: this.createMessageComponent(block.message) };
	}

	private blockSignature(block: ProjectedTranscriptBlock): string {
		return JSON.stringify(block);
	}

	private createMessageComponent(message: MycliShellMessage): Component {
		if (message.role === "user") {
			return new UserMessageComponent(message.text);
		}
		if (message.role === "assistant") {
			return new AssistantMessageComponent(message.text, message.thinking, message.thinkingHidden ?? true);
		}
		const color = message.role === "error" ? "error" : message.role === "warning" ? "warning" : "muted";
		return new Text(theme.fg(color, message.text), 1, 0);
	}

	private rebuildPending(): void {
		this.pendingMessagesContainer.clear();
		if (this.state.pendingNotice && !this.state.pendingApproval) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			this.pendingMessagesContainer.addChild(new Text(theme.fg("warning", this.state.pendingNotice), 1, 0));
		}
		const steering = this.state.footer.steeringQueueCount ?? 0;
		const followUp = this.state.footer.followUpQueueCount ?? 0;
		if (steering > 0 || followUp > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			if (steering > 0) {
				this.pendingMessagesContainer.addChild(new Text(theme.fg("muted", `Steering queued: ${steering}`), 1, 0));
			}
			if (followUp > 0) {
				this.pendingMessagesContainer.addChild(new Text(theme.fg("muted", `Follow-up queued: ${followUp}`), 1, 0));
			}
			this.pendingMessagesContainer.addChild(new Text(theme.fg("dim", "↳ option+up to edit all queued messages"), 1, 0));
		}
		if (this.state.activePlan?.length) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			this.pendingMessagesContainer.addChild(new PlanPanelComponent(this.state.activePlan));
		}
	}

	private rebuildStatus(): void {
		this.statusContainer.clear();
		if (this.isRunningLiveState(this.state.footer.liveState) || this.isCompletedLiveState(this.state.footer.liveState)) {
			return;
		}
		if (this.state.footer.liveState && this.state.footer.liveState !== "Idle") {
			this.statusContainer.addChild(new Text(theme.fg("muted", this.state.footer.liveState), 1, 0));
		}
	}

	private rebuildSubagentTasks(): void {
		this.subagentTaskContainer.clear();
		const agents = this.visibleSubagents();
		if (agents.length === 0) {
			return;
		}
		this.subagentTaskContainer.addChild(
			new SubagentTaskPanelComponent({
				agents,
				onOpen: () => this.showBackgroundSubagents(),
			}),
		);
	}

	private visibleSubagents(): MycliShellSubagent[] {
		const transcript = this.state.transcript ?? [];
		const seen = new Map<string, MycliShellSubagent>();
		for (const block of transcript) {
			if (block.kind !== "subagent") {
				continue;
			}
			if (isResolvedSubagent(block.subagent)) {
				continue;
			}
			if (this.dismissedSubagentIds.has(block.subagent.id)) {
				continue;
			}
			seen.set(block.subagent.id, block.subagent);
		}
		return [...seen.values()];
	}

	private updateStatusTiming(previousState: MycliShellState, nextState: MycliShellState): void {
		const wasRunning = this.isRunningLiveState(previousState.footer.liveState);
		const isRunning = this.isRunningLiveState(nextState.footer.liveState);
		if (!wasRunning && isRunning) {
			this.turnStartedAtMs = this.now();
			this.completedDurationMs = null;
			return;
		}
		if (wasRunning && !isRunning) {
			this.completedDurationMs = this.turnStartedAtMs === null ? 0 : Math.max(0, this.now() - this.turnStartedAtMs);
			if (!this.isCompletedLiveState(nextState.footer.liveState)) {
				this.turnStartedAtMs = null;
			}
		}
	}

	private isRunningLiveState(liveState: string | undefined): boolean {
		const normalized = liveState?.trim().toLowerCase() ?? "";
		return normalized === "running" || normalized === "thinking" || normalized === "streaming";
	}

	private isCompletedLiveState(liveState: string | undefined): boolean {
		return liveState?.trim().toLowerCase() === "completed";
	}

	private stopTurnActivity(): void {
		this.turnActivity?.stop();
		this.turnActivity = null;
	}

	private rebuildFooter(): void {
		this.footerContainer.clear();
		this.footerContainer.addChild(new Spacer(1));
		const sendHint = this.isTurnRunning() ? rawKeyHint("enter", "steer") : rawKeyHint("enter", "send");
		this.footerContainer.addChild(new Text(`${theme.fg("dim", "▸")} ${theme.fg("muted", "Message mycli")}  ${sendHint}  ${rawKeyHint("option+enter", "follow-up")}  ${rawKeyHint("ctrl+c", "interrupt")}  ${rawKeyHint("option+up", "dequeue")}`, 1, 0));
		this.footerContainer.addChild(new FooterComponent(this.state.footer));
	}

	private async handleSubmit(text: string): Promise<void> {
		const input = text.trim();
		if (!input) {
			return;
		}
		if (input === "/help") {
			this.editor.setText("");
			this.showCommandPalette();
			return;
		}
		if (input === "/") {
			this.editor.setText("");
			this.showCommandPalette();
			return;
		}
		if (input.startsWith("/")) {
			const commandId = input.slice(1).split(/\s+/, 1)[0] ?? "";
			if (commandId === "settings") {
				this.editor.addToHistory(input);
				this.editor.setText("");
				this.showSettingsSelector();
				return;
			}
			if (commandId === "resources") {
				this.editor.addToHistory(input);
				this.editor.setText("");
				await this.showResourceSelector();
				return;
			}
			if (commandId === "tasks" && input.trim() === "/tasks") {
				this.editor.addToHistory(input);
				this.editor.setText("");
				this.showBackgroundSubagents();
				return;
			}
			const exactCommand = this.commands().find((candidate) => candidate.label === input);
			if (exactCommand) {
				this.editor.addToHistory(input);
				this.editor.setText("");
				await exactCommand.run();
				return;
			}
			if (input.trim() === "/session tree") {
				this.editor.addToHistory(input);
				this.editor.setText("");
				await this.showSessionTreeSelector();
				return;
			}
			if (commandId === "session" || commandId === "resume") {
				if (commandId === "resume" && input.trim().includes(" ")) {
					this.editor.addToHistory(input);
					this.editor.setText("");
					await this.submitCommand(input);
					return;
				}
				if (commandId === "session" && input.trim().includes(" ")) {
					this.editor.addToHistory(input);
					this.editor.setText("");
					await this.submitCommand(input);
					return;
				}
				this.editor.addToHistory(input);
				this.editor.setText("");
				this.showSessionSelector();
				return;
			}
			if (commandId === "model") {
				const searchTerm = input.startsWith("/model ") ? input.slice(7).trim() : undefined;
				this.editor.addToHistory(input);
				this.editor.setText("");
				this.showModelSelector(searchTerm);
				return;
			}
			if (commandId === "login") {
				this.editor.addToHistory(input);
				this.editor.setText("");
				this.showLoginFlow();
				return;
			}
			if (commandId === "view") {
				this.editor.addToHistory(input);
				this.editor.setText("");
				this.setViewMode(input.slice("/view".length).trim());
				return;
			}
			if (this.isBackendCommand(commandId)) {
				this.editor.addToHistory(input);
				this.editor.setText("");
				await this.submitCommand(input);
				return;
			}
			const command = this.commands().find((candidate) => candidate.id === commandId);
			if (command) {
				this.editor.addToHistory(input);
				this.editor.setText("");
				await command.run();
				return;
			}
		}
		this.editor.addToHistory(input);
		this.editor.setText("");
		this.lastSubmittedInput = input;
		this.lastCtrlCAtMs = null;
		await this.options.onSubmit?.(input);
	}

	private async submitFollowUp(): Promise<void> {
		const input = this.editor.getText().trim();
		if (!input) {
			return;
		}
		this.editor.addToHistory(input);
		this.editor.setText("");
		await (this.options.onFollowUp ?? this.options.onSubmit)?.(input);
	}

	private async restoreQueuedInput(): Promise<void> {
		const queued = await this.options.onDequeueQueuedInput?.();
		if (!queued) {
			this.addSystemNotice("No queued message to restore.");
			return;
		}
		this.restoreQueuedTextToEditor(queued);
	}

	private async handleInterrupt(): Promise<void> {
		if (this.selectorActive) {
			if (this.approvalSurfaceDecisionId !== null) {
				return;
			}
			this.restoreEditor();
			return;
		}
		if (this.isTurnRunning()) {
			await this.options.onInterrupt?.();
			this.restoreLastSubmittedInput();
			this.addSystemNotice("Interrupted.");
			return;
		}
		if (this.editor.getText().length > 0) {
			this.editor.setText("");
			return;
		}
		this.restoreEditor();
	}

	private async handleCtrlC(): Promise<void> {
		if (this.isTurnRunning()) {
			await this.handleInterrupt();
			this.lastCtrlCAtMs = null;
			return;
		}
		if (this.editor.getText().length > 0) {
			this.editor.setText("");
			this.lastCtrlCAtMs = null;
			return;
		}
		const now = this.now();
		if (this.lastCtrlCAtMs !== null && now - this.lastCtrlCAtMs <= 2000) {
			await this.shutdown();
			return;
		}
		this.lastCtrlCAtMs = now;
		this.addSystemNotice("Press Ctrl+C again to exit.");
	}

	private restoreQueuedTextToEditor(queued: string): void {
		const current = this.editor.getText().trim();
		this.editor.setText([queued, current].filter((text) => text.trim()).join("\n\n"));
	}

	private restoreLastSubmittedInput(): void {
		const submitted = this.lastSubmittedInput?.trim();
		if (!submitted) {
			return;
		}
		this.editor.removeLastFromHistory?.(submitted);
		this.restoreQueuedTextToEditor(submitted);
		this.lastSubmittedInput = null;
	}

	private isTurnRunning(): boolean {
		const liveState = this.state.footer.liveState?.trim().toLowerCase() ?? "";
		return ["running", "thinking", "streaming", "waiting approval", "waiting clarification"].includes(liveState);
	}

	private commands(): MycliShellCommand[] {
		const commands: MycliShellCommand[] = [
			...(this.options.commands ?? []),
			{
				id: "settings",
				label: "/settings",
				description: "Open settings",
				run: () => this.showSettingsSelector(),
			},
			{
				id: "session",
				label: "/session",
				description: "Resume session",
				run: () => this.showSessionSelector(),
			},
			{
				id: "session-tree",
				label: "/session tree",
				description: "Inspect conversation tree",
				run: () => void this.showSessionTreeSelector(),
			},
			{
				id: "model",
				label: "/model",
				description: "Select model",
				run: () => this.showModelSelector(),
			},
			{
				id: "login",
				label: "/login",
				description: "Configure provider credentials",
				run: () => this.showLoginFlow(),
			},
			{
				id: "trust",
				label: "/trust",
				description: "Review workspace trust",
				run: () => this.showTrustGate(),
			},
			{
				id: "tasks",
				label: "/tasks",
				description: "Open background tasks",
				run: () => this.showBackgroundSubagents(),
			},
			{
				id: "tools",
				label: "/tools",
				description: "Inspect backend tools",
				run: () => this.submitCommand("/tools"),
			},
			{
				id: "details",
				label: "/details",
				description: "Toggle compact tool details",
				run: () => this.toggleToolDetails(),
			},
			{
				id: "view",
				label: "/view",
				description: "Switch tool visibility: default, verbose, focus",
				run: () => this.addSystemNotice("Usage: /view default | /view verbose | /view focus"),
			},
			{
				id: "hotkeys",
				label: "/hotkeys",
				description: "Show keyboard shortcuts",
				run: () => this.showHotkeys(),
			},
			{
				id: "copy",
				label: "/copy",
				description: "Copy last assistant message",
				run: () => this.copyLastAssistantMessage(),
			},
			{
				id: "new",
				label: "/new",
				description: "Start a fresh local transcript",
				run: () => this.startNewLocalSession(),
			},
			{
				id: "clear",
				label: "/clear",
				description: "Clear local transcript view",
				run: () => this.setState({ ...this.state, messages: [], tools: [], bash: [], transcript: [], pendingNotice: undefined }),
			},
			{
				id: "quit",
				label: "/quit",
				description: "Exit mycli",
				run: () => this.shutdown(),
			},
		];
		const commandIds = new Set(commands.map((command) => command.id));
		for (const command of BACKEND_COMMANDS) {
			if (this.localCommandIds().has(command.id) || commandIds.has(command.id)) {
				continue;
			}
			commands.push({
				...command,
				run: () => this.submitCommand(command.label),
			});
			commandIds.add(command.id);
		}
		return commands;
	}

	private refreshAutocompleteProvider(): void {
		const slashCommands: SlashCommand[] = this.commands().map((command) => ({
			name: command.label.replace(/^\//, ""),
			description: command.description,
		}));
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(slashCommands, this.autocompleteBasePath()),
		);
	}

	private autocompleteBasePath(): string {
		const cwd = this.state.footer.cwd?.trim();
		if (!cwd || cwd.startsWith("~")) {
			return process.cwd();
		}
		return cwd;
	}

	private localCommandIds(): Set<string> {
		return new Set([
			"settings",
			"session",
			"resume",
			"model",
			"trust",
			"jobs",
			"tools",
			"details",
			"view",
			"hotkeys",
			"copy",
			"new",
			"clear",
			"quit",
		]);
	}

	private isBackendCommand(commandId: string): boolean {
		return BACKEND_COMMANDS.some((command) => command.id === commandId || command.label === `/${commandId}`);
	}

	private async submitCommand(command: string): Promise<void> {
		if (this.options.onCommandSubmit) {
			await this.options.onCommandSubmit(command);
			return;
		}
		await this.options.onSubmit?.(command);
	}

	private async cycleCollaborationMode(): Promise<void> {
		const currentMode = this.state.footer.collaborationMode ?? "default";
		const nextMode = currentMode === "plan" ? "default" : "plan";
		this.addSystemNotice(`Mode ${nextMode}`);
		await this.submitCommand(`/mode ${nextMode}`);
	}

	private async cycleSandboxMode(): Promise<void> {
		this.addSystemNotice("Sandbox next");
		await this.submitCommand("/sandbox next");
	}

	private toggleToolDetails(): void {
		const nextTools = this.state.tools.map((tool) => ({ ...tool, expanded: !tool.expanded }));
		const nextBash = this.state.bash.map((bash) => ({ ...bash, expanded: !bash.expanded }));
		const toolById = new Map(nextTools.map((tool) => [tool.id, tool]));
		const bashById = new Map(nextBash.map((bash) => [bash.id, bash]));
		this.setState({
			...this.state,
			tools: nextTools,
			bash: nextBash,
			transcript: this.state.transcript?.map((block) => {
				if (block.kind === "tool") {
					return { ...block, tool: toolById.get(block.tool.id) ?? { ...block.tool, expanded: !block.tool.expanded } };
				}
				if (block.kind === "bash") {
					return { ...block, bash: bashById.get(block.bash.id) ?? { ...block.bash, expanded: !block.bash.expanded } };
				}
				return block;
			}),
		});
	}

	private setViewMode(rawMode: string): void {
		const mode = rawMode === "verbose" || rawMode === "focus" || rawMode === "default" ? rawMode : null;
		if (!mode) {
			this.addSystemNotice("Usage: /view default | /view verbose | /view focus");
			return;
		}
		const next = this.applyToolVisibility({
			...this.state,
			settings: { ...this.state.settings, viewMode: mode },
		});
		this.setState({
			...next,
			footer: {
				...next.footer,
				liveState: `View ${mode}`,
			},
		});
	}

	private applyToolVisibility(state: MycliShellState): MycliShellState {
		const viewMode = state.settings?.viewMode ?? "default";
		const toolHidden = (tool: MycliShellState["tools"][number]): boolean => {
			if (viewMode === "verbose") return false;
			if (tool.status === "running" || tool.status === "error" || tool.mutating) return false;
			const lower = tool.name.toLowerCase();
			if (lower === "bash" || lower === "shell") return false;
			if (viewMode === "focus") return true;
			return ["read", "grep", "glob", "ls", "gitstatus", "gitlog", "gitshow", "gitdiff"].includes(lower);
		};
		const tools = state.tools.map((tool) => ({ ...tool, hidden: toolHidden(tool) }));
		const toolById = new Map(tools.map((tool) => [tool.id, tool]));
		return {
			...state,
			tools,
			transcript: state.transcript?.map((block) => {
				if (block.kind !== "tool") return block;
				return { ...block, tool: toolById.get(block.tool.id) ?? { ...block.tool, hidden: toolHidden(block.tool) } };
			}),
		};
	}

	private showHotkeys(): void {
		this.addSystemNotice(
			[
				"Hotkeys",
				"ctrl+p commands · ? help",
				"enter send/steer · esc interrupt",
				"ctrl+l model · ctrl+o tools · ctrl+x sandbox",
				"ctrl+c clear/exit · alt+enter follow-up · alt+up dequeue",
			].join("\n"),
		);
	}

	private copyLastAssistantMessage(): void {
		const message = [...this.state.messages].reverse().find((candidate) => candidate.role === "assistant" && candidate.text.trim());
		if (!message) {
			this.addSystemNotice("No assistant message to copy yet.");
			return;
		}
		const copied = copyTextBestEffort(message.text);
		this.addSystemNotice(copied ? "Copied last assistant message." : "Clipboard unavailable. Last assistant message is still visible above.");
	}

	private startNewLocalSession(): void {
		this.setState({
			...this.state,
			messages: [],
			tools: [],
			bash: [],
			transcript: [],
			pendingNotice: undefined,
			footer: {
				...this.state.footer,
				sessionName: `session_${Date.now().toString(36)}`,
				liveState: "New session",
			},
		});
	}

	private addSystemNotice(text: string): void {
		const id = `notice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const message: MycliShellMessage = { id, role: "system", text };
		const transcript = this.state.transcript ?? this.legacyTranscriptBlocks();
		this.setState({
			...this.state,
			messages: [...this.state.messages, message],
			transcript: [...transcript, { id, kind: "message", message }],
			pendingNotice: undefined,
		});
	}

	private patchFooter(footerPatch: Partial<MycliShellState["footer"]>): void {
		this.setState({ ...this.state, footer: { ...this.state.footer, ...footerPatch } });
	}

	private async applySettingsChange(settings: MycliShellVisualSettings): Promise<void> {
		const previousSettings = this.state.settings;
		const optimisticState = this.applyToolVisibility({ ...this.state, settings });
		this.setState({
			...optimisticState,
			footer: {
				...optimisticState.footer,
				liveState: "Settings",
			},
		});
		try {
			const savedSettings = await this.options.onSettingsChange?.(settings);
			if (savedSettings) {
				const savedState = this.applyToolVisibility({ ...this.state, settings: savedSettings });
				this.setState({
					...savedState,
					footer: {
						...savedState.footer,
						liveState: "Settings saved",
					},
				});
			}
		} catch (error) {
			const restoredState = this.applyToolVisibility({ ...this.state, settings: previousSettings });
			this.setState(restoredState);
			this.addSystemNotice(`Failed to save settings: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private authProviders(): MycliShellAuthProvider[] {
		if (this.state.authProviders?.length) {
			return this.state.authProviders;
		}
		return [
			{ id: "openai", name: "OpenAI", defaultModel: "gpt-5" },
			{ id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-v4-flash" },
			{ id: "qwen", name: "Qwen", defaultModel: "qwen-plus" },
			{ id: "anthropic", name: "Anthropic", defaultModel: "claude-sonnet-4-5" },
			{ id: "compatible", name: "Compatible" },
		];
	}

	private async submitApiKeyLogin(providerId: string, apiKey: string, done: () => void): Promise<void> {
		try {
			const result = await this.options.onApiKeyLogin?.(providerId, apiKey);
			const message = result && "message" in result && result.message
				? result.message
				: `Saved API key for ${this.authProviderName(providerId)}.`;
			this.addSystemNotice(message);
			const nextState = {
				...this.state,
				authProviders: this.authProviders().map((provider) =>
					provider.id === providerId ? { ...provider, configured: true } : provider,
				),
			};
			this.setState(nextState);
			const providerModels = this.modelsForProvider(providerId);
			if (providerModels.length > 0) {
				this.showModelSelector(providerId);
			} else {
				done();
			}
		} catch (error) {
			this.addSystemNotice(`Failed to save API key: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private authProviderName(providerId: string): string {
		return this.authProviders().find((provider) => provider.id === providerId)?.name ?? providerId;
	}

	private modelsForProvider(providerId: string): MycliShellModel[] {
		return (this.state.models ?? []).filter((model) => model.provider === providerId);
	}

	private async selectModel(model: MycliShellModel): Promise<void> {
		this.setState({
			...this.state,
			currentModel: model,
			footer: {
				...this.state.footer,
				provider: model.provider,
				model: model.id,
				reasoningLevel: model.thinkingLevel ?? this.state.footer.reasoningLevel,
			},
		});
		await this.options.onModelSelect?.(model);
	}

	private async selectSession(sessionId: string): Promise<void> {
		this.setState({
			...this.state,
			footer: {
				...this.state.footer,
				sessionName: sessionId,
			},
		});
		await this.options.onSessionSelect?.(sessionId);
	}

	private async inspectResource(resource: MycliShellResource): Promise<void> {
		const command = resource.command ?? resourceInspectCommand(resource.type);
		if (!command) {
			this.addSystemNotice(`No runtime inspect command for ${resource.type} ${resource.name}.`);
			return;
		}
		await this.options.onCommandSubmit?.(command);
	}
}

function resourceInspectCommand(type: MycliShellResource["type"]): string | null {
	switch (type) {
		case "hook":
			return "/tools hooks";
		case "plugin":
			return "/tools plugins";
		case "skill":
			return "/tools skills";
		case "prompt":
			return "/help";
		case "theme":
			return "/settings";
	}
}

function elapsedSecondsFor(durationMs: number): number {
	return Math.max(0, Math.floor(durationMs / 1000));
}

function copyTextBestEffort(text: string): boolean {
	if (process.platform === "darwin") {
		const result = spawnSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"] });
		return result.status === 0;
	}
	return false;
}
