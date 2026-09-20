import { TerminalAttention } from "../platform/terminal-attention.ts";
import { modelSelectionNotice } from "@mycli/contracts";
import { ReviewSelectorComponent } from "../components/selectors/review-selector.ts";
import { TextEntrySelectorComponent } from "../components/selectors/text-entry-selector.ts";
import { TextViewerSelectorComponent } from "../components/selectors/text-viewer-selector.ts";
import { HooksSelectorComponent } from "../components/selectors/hooks-selector.ts";
import { parseSkillReferences, skillReferencesInText, MAX_SKILL_REFERENCES, type SkillReference } from "@mycli/contracts";
import { SkillsSelectorComponent } from "../components/selectors/skills-selector.ts";
import type { ModelSelectionScope } from "@mycli/contracts";
import { CustomEditor } from "../components/composer/custom-editor.ts";
import { FooterComponent } from "../components/composer/footer.ts";
import { WorkStatusComponent } from "../components/composer/work-status.ts";
import { StatusMessageComponent } from "../components/composer/status-line.ts";
import { PendingInputPreviewComponent } from "../components/composer/pending-input-preview.ts";
import { ApprovalSelectorComponent } from "../components/selectors/approval-selector.ts";
import { ClarificationSelectorComponent } from "../components/selectors/clarification-selector.ts";
import { McpElicitationSelectorComponent } from "../components/selectors/mcp-elicitation-selector.ts";
import { CommandPaletteComponent } from "../components/selectors/command-palette.ts";
import { CommandResultOverlayComponent } from "../components/selectors/command-result-overlay.ts";
import type { DecisionPanelOptions } from "../components/selectors/decision-panel.ts";
import { HelpOverlayComponent } from "../components/selectors/help-overlay.ts";
import { LoginFlowComponent } from "../components/selectors/login-flow.ts";
import { defaultAuthProviders } from "../interaction/provider-defaults.ts";
import { ModelSelectorComponent } from "../components/selectors/model-selector.ts";
import { PermissionSelectorComponent } from "../components/selectors/permission-selector.ts";
import { PlanImplementationSelectorComponent } from "../components/selectors/plan-implementation-selector.ts";
import { ResourceSelectorComponent } from "../components/selectors/resource-selector.ts";
import { PluginSelectorComponent } from "../components/selectors/plugin-selector.ts";
import { SessionRepairSelectorComponent } from "../components/selectors/session-repair-selector.ts";
import { SessionSelectorComponent } from "../components/selectors/session-selector.ts";
import { SessionTreeSelectorComponent } from "../components/selectors/session-tree-selector.ts";
import {
	SettingsSelectorComponent,
	type SettingsChangeScope,
} from "../components/selectors/settings-selector.ts";
import {
	ConnectivityStepComponent,
	ReadyStepComponent,
	WelcomeStepComponent,
} from "../components/selectors/startup-onboarding.ts";
import { TrustSelectorComponent, type ProjectTrustDecision } from "../components/selectors/trust-selector.ts";
import { FrameCachedContainer } from "../components/shared/frame-cached-container.ts";
import { rawKeyHint } from "../components/shared/keybinding-hints.ts";
import { AssistantMessageComponent } from "../components/transcript/assistant-message.ts";
import {
	BackgroundSubagentDialogComponent,
	isResolvedSubagent,
	SubagentTaskPanelComponent,
} from "../components/transcript/subagent-task-panel.ts";
import {
	syncTranscriptBlock,
	type RenderedTranscriptBlock,
} from "../components/transcript/transcript-block.ts";
import { TranscriptViewerComponent } from "../components/transcript/transcript-viewer.ts";
import { TranscriptViewportComponent } from "../components/transcript/transcript-viewport.ts";
import { TranscriptAreaComponent } from "../components/transcript/transcript-area.ts";
import { TurnActivityComponent } from "../components/transcript/turn-activity.ts";
import { applyMycliKeymap, installMycliKeybindings } from "../interaction/keybindings.ts";
import {
	planImplementationContextUsageLabel,
	planImplementationMessage,
	type PlanImplementationAction,
} from "../interaction/plan-implementation.ts";
import { commandRoutingNames, isSlashCommandSubmission } from "../interaction/slash-commands.ts";
import { isMycliUiQueuedInput, type MycliUiAction } from "../interaction/ui-actions.ts";
import type {
	MycliShellAuthProvider,
	MycliShellCommandResult,
	MycliShellCommandSpec,
	MycliShellMessage,
	MycliShellModel,
	MycliShellPendingApproval,
	MycliShellPendingClarification,
	MycliShellPermissionProfile,
	MycliShellResource,
	MycliShellResumeRepairAction,
	MycliShellResumeRepairPreview,
	MycliShellSession,
	MycliShellSessionTreeNode,
	MycliShellSettingsItem,
	MycliShellState,
	MycliShellSubagent,
	MycliShellTranscriptBlock,
	MycliShellVisualSettings,
	TranscriptUpdateKind,
} from "../model.ts";
import { copyText } from "../platform/clipboard.ts";
import { safeErrorMessage } from "../safe-ui-text.ts";
import { setUiGlyphMode, uiGlyphs } from "../theme/terminal-style.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { ToolDetailProjector, type ToolDetailMode } from "../transcript/tool-detail-projection.ts";
import {
	createTranscriptProjection,
	projectTranscriptTail,
	type ProjectedTranscriptBlock,
	type TranscriptProjectionState,
} from "../transcript/transcript-projection.ts";
import { resolveTranscriptReplayMaxRows } from "../transcript/transcript-replay.ts";
import { CombinedAutocompleteProvider, type SlashCommand } from "../tui-core/autocomplete.ts";
import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import type { KeybindingsManager } from "../tui-core/keybindings.ts";
import { matchesKey } from "../tui-core/keys.ts";
import { isImageFilePath } from "../tui-core/terminal-image.ts";
import { ProcessTerminal } from "../tui-core/terminal.ts";
import {
	Container,
	TUI,
	type Component,
	type OverlayHandle,
	type TUIScreenSnapshot,
} from "../tui-core/tui.ts";
import { nextImagePlaceholder } from "./local-image-attachments.ts";
import { expandEditorDraft, type EditorDraft } from "../tui-core/components/editor.ts";
import { prependDraftInputs, type ComposerDraft } from "./composer-draft.ts";
import type {
	MycliShellLocalImageAttachment,
	MycliShellQueuedInput,
	MycliShellRuntimeOptions,
	MycliShellStateUpdateOptions,
} from "./runtime-options.ts";
import {
	authRecoveryFromError,
	defaultPermissionState,
	permissionStateWithActive,
	settingsCatalogWithChoice,
	settingsSnapshot,
	visualSettingsWithChoice,
	visualSettingValue,
} from "./settings-values.ts";
import {
	StartupOnboardingCoordinator,
	type StartupOnboardingInput,
	type StartupOnboardingStage,
} from "./startup-onboarding.ts";

type ComposerSessionSnapshot = {
	draft: EditorDraft;
	pendingLocalImages: MycliShellLocalImageAttachment[];
	skillReferences: readonly SkillReference[];
	lastSubmittedInput: MycliShellQueuedInput | null;
	lastSubmittedInputEligible: boolean;
	lastSubmittedActivitySignature: string;
	userTurnPendingStart: boolean;
};

type ActiveTranscriptViewer = {
	readonly component: TranscriptViewerComponent;
	readonly handle: OverlayHandle;
	readonly screen: TUIScreenSnapshot;
	readonly enteredAlternateScreen: boolean;
	loadingHistory: boolean;
	blocksSource: readonly MycliShellTranscriptBlock[];
};

type SelectorEntry = {
	readonly component: Component;
	readonly focus: Component;
	readonly dispose?: () => void;
};

const NATIVE_RESIZE_REFLOW_DEBOUNCE_MS = 75;

export class MycliShellRuntime {
	readonly ui: TUI;
	readonly headerContainer = new Container();
	readonly chatContainer = new Container();
	readonly transcriptContainer = new Container();
	readonly transcriptViewport: TranscriptViewportComponent;
	readonly transcriptArea: TranscriptAreaComponent;
	readonly pendingMessagesContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId);
	readonly statusContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId);
	readonly workStatusContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId, true);
	readonly editorContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId);
	readonly subagentTaskContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId, true);
	readonly footerContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId, true);
	readonly editor: CustomEditor;
	private readonly keybindings: KeybindingsManager;

	private state: MycliShellState;
	private commandCatalog: MycliShellCommandSpec[];
	private routingNames: string[];
	private transcriptRenderRevision = 0;
	private started = false;
	private mainMounted = false;
	private chatBlocks = new Map<string, RenderedTranscriptBlock>();
	private projectedChatBlocks: ProjectedTranscriptBlock[] = [];
	private transcriptProjection: TranscriptProjectionState | null = null;
	private turnActivity: TurnActivityComponent | null = null;
	private turnStartedAtMs: number | null = null;
	private operationStartedAtMs: number | null = null;
	private exitHintTimer: NodeJS.Timeout | null = null;
	private exitHintVisible = false;
	private readonly attention = new TerminalAttention((sequence) => { if (this.started) this.ui.terminal.write(sequence); });
	private selectorActive = false;
	private selectorStack: SelectorEntry[] = [];
	private sessionTransitionDepth = 0;
	private sessionRevision = 0;
	private approvalSurfaceDecisionId: string | null = null;
	private clarificationSurfaceRequestId: string | null = null;
	private readonly now: () => number;
	private lastCtrlCAtMs: number | null = null;
	private lastSubmittedInput: MycliShellQueuedInput | null = null;
	private lastSubmittedInputEligible = false;
	private lastSubmittedActivitySignature = "";
	private userTurnPendingStart = false;
	private interruptRequestPending = false;
	private dismissedSubagentIds = new Set<string>();
	private skillReferences: readonly SkillReference[] = [];
	private pendingLocalImages: MycliShellLocalImageAttachment[] = [];
	private readonly composerSnapshots = new Map<string, ComposerSessionSnapshot>();
	private toolDetailMode: ToolDetailMode = "default";
	private readonly toolDetailProjector = new ToolDetailProjector();
	private nativeResizeTimer: ReturnType<typeof setTimeout> | undefined;
	private nativeTranscriptDeltaHeld = false;
	private transcriptViewer: ActiveTranscriptViewer | null = null;
	private startupOnboarding: StartupOnboardingCoordinator | null;
	private startupProviderId: string | undefined;

	constructor(private readonly options: MycliShellRuntimeOptions) {
		this.state = options.initialState;
		this.commandCatalog = [...(options.commands ?? [])];
		this.routingNames = [...(options.commandNames ?? commandRoutingNames(this.commandCatalog))];
		const startupOnboarding = options.deferStartupGates === true
			? null
			: new StartupOnboardingCoordinator({
				authenticationRequired: this.startupAuthenticationRequired(),
				trustRequired: options.requireTrust === true,
				modelSelectionAvailable: (this.state.models?.length ?? 0) > 0,
			});
		this.startupOnboarding = startupOnboarding?.current() ? startupOnboarding : null;
		this.now = options.now ?? Date.now;
		this.ui = new TUI(options.terminal ?? new ProcessTerminal());
		this.applyVisualSettings(this.state.settings, this.state.terminalCapabilities);
		this.ui.onResize = () => this.handleTerminalResize();
		this.ui.onSuspend = options.onSuspend;
		this.ui.onFatalError = options.onFatalError;
		this.ui.onResume = () => {
			if (this.ui.terminal.nativeScrollback && this.mainMounted) {
				this.queueNativeTranscriptHistory(true);
			}
		};
		this.transcriptContainer.addChild(this.headerContainer);
		this.transcriptContainer.addChild(this.chatContainer);
		const configuredReplayMaxRows = options.transcriptReplayMaxRows;
		this.transcriptViewport = new TranscriptViewportComponent(
			this.transcriptContainer,
			(width) => this.transcriptHeight(width),
			configuredReplayMaxRows === 0
				? undefined
				: configuredReplayMaxRows ?? resolveTranscriptReplayMaxRows(),
			() => this.transcriptRenderRevision,
		);
		this.transcriptArea = new TranscriptAreaComponent(
			this.transcriptViewport,
			this.statusContainer,
			(width) => this.transcriptHeight(width) + this.statusContainer.render(width).length,
		);
		this.keybindings = installMycliKeybindings(this.state.keymap?.bindings);
		this.editor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: 1,
			autocompleteMaxVisible: 8,
			onDroppedImageFile: (path) => this.registerDroppedImageFile(path),
			captureLocalImages: () => this.pendingLocalImages,
			restoreLocalImages: (images) => { this.pendingLocalImages = images.map((image) => ({ ...image })); },
		});
		this.refreshAutocompleteProvider();
		this.editor.onChange = (text) => {
			this.clearExitHint();
			if (this.promotePlainImagePathInput(text)) {
				return;
			}
			this.retainPendingImagesInText(text);
		};
		this.editor.onSubmit = (text, draft) => {
			const submittedDraft = this.composerDraft(draft ?? { text, pastes: [], cursor: { line: 0, col: 0 } });
			this.runAsyncAction(() => this.handleSubmit(text, submittedDraft), "Message submission failed");
		};
		this.editor.shouldHandleAction = (action) => {
			if (action === "app.message.followUp") {
				return this.isTurnRunning();
			}
			if (action === "app.message.dequeue") {
				return this.hasQueuedInput();
			}
			return true;
		};
		this.editor.onEscape = () => {
			this.runAsyncAction(() => this.handleInterrupt(), "Interrupt request failed");
		};
		this.editor.onAction("app.interrupt", () => {
			this.runAsyncAction(() => this.handleInterrupt(), "Interrupt request failed");
		});
		this.editor.onAction("app.exit", () => {
			this.runAsyncAction(() => this.shutdown(), "Exit failed");
		});
		this.editor.onAction("app.commandPalette", () => this.showCommandPalette());
		this.editor.onAction("app.help", () => this.showHelp());
		this.editor.onAction("app.model.select", () => this.showModelSelector());
		this.editor.onAction("app.permissions.open", () => {
			this.showPermissionSelector();
		});
		this.editor.onAction("app.message.followUp", () => {
			this.runAsyncAction(() => this.submitFollowUp(this.composerDraft()), "Follow-up submission failed");
		});
		this.editor.onAction("app.message.dequeue", () => {
			this.runAsyncAction(() => this.restoreQueuedInput(), "Queued message restore failed");
		});
		this.editor.onAction("app.tools.expand", () => this.toggleToolDetails());
		this.editor.onAction("app.transcript.open", () => this.showTranscriptViewer());
		this.ui.addInputListener((data) => this.handleGlobalInput(data));
		this.editorContainer.addChild(this.editor);
		if (!this.startupOnboarding) {
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
		if (this.startupOnboarding) {
			this.showStartupOnboardingStage();
		} else if (!this.selectorActive) {
			this.ui.setFocus(this.editor);
		}
	}

	/**
	 * Evaluates the startup gates that were deferred while the first session
	 * payload was loading. Either opens the pending onboarding stage or hands
	 * focus to the composer.
	 */
	applyStartupGates(input: StartupOnboardingInput): void {
		if (!this.options.deferStartupGates) return;
		const coordinator = new StartupOnboardingCoordinator(input);
		this.startupOnboarding = coordinator.current() ? coordinator : null;
		if (!this.startupOnboarding) {
			if (this.mainMounted && this.selectorActive) {
				this.ui.requestRender();
				return;
			}
			this.finishStartupOnboarding();
			return;
		}
		if (this.started) {
			this.showStartupOnboardingStage();
		}
	}

	setState(nextState: MycliShellState, options: MycliShellStateUpdateOptions = {}): void {
		const previousState = this.state;
		const effectiveState = this.applyToolDetailMode(nextState, options.transcriptUpdate);
		const sessionChanged = previousState.sessionId !== effectiveState.sessionId;
		if (sessionChanged) {
			this.sessionRevision += 1;
			if (this.selectorStack.some((entry) => entry.dispose)) this.restoreEditor();
			// The shell paints before the first session arrives, so the composer may
			// already hold text the user typed during startup. Adopt it as the draft
			// of the session that is activating instead of dropping it.
			this.captureComposerSession(previousState.sessionId ?? effectiveState.sessionId);
			this.closeTranscriptViewer();
		}
		const settingsChanged = this.settingsSignature(previousState) !== this.settingsSignature(effectiveState);
		const transcriptAppended = this.transcriptBlockCount(effectiveState) > this.transcriptBlockCount(previousState);
		if (
			this.lastSubmittedInputEligible &&
			this.visibleTurnActivitySignature(effectiveState) !== this.lastSubmittedActivitySignature
		) {
			this.lastSubmittedInputEligible = false;
		}
		if (this.isTurnActivityRunning(effectiveState)) {
			this.userTurnPendingStart = false;
		}
		this.updateStatusTiming(previousState, effectiveState);
		if (settingsChanged) {
			applyMycliKeymap(this.keybindings, effectiveState.keymap?.bindings);
		}
		this.applyVisualSettings(effectiveState.settings, effectiveState.terminalCapabilities);
		this.state = effectiveState;
		if (sessionChanged) this.restoreComposerSession(effectiveState.sessionId);
		this.updateTranscriptViewer(effectiveState);
		if (this.mainMounted) {
			if (settingsChanged) {
				this.rebuildForVisualSettings();
			} else {
				this.rebuildChangedSections(previousState, effectiveState, options.transcriptUpdate);
			}
		}
		this.maybeShowPlanImplementation(options.eventType);
		this.attention.configure(effectiveState.settings?.terminalNotifications ?? true);
		if (sessionChanged) this.attention.clear();
		else if (options.eventType) {
			if (effectiveState.pendingApproval?.decisionId && effectiveState.pendingApproval.decisionId !== previousState.pendingApproval?.decisionId) this.attention.notify("Approval required", 2);
			else if (effectiveState.pendingClarification?.requestId && effectiveState.pendingClarification.requestId !== previousState.pendingClarification?.requestId) this.attention.notify("Answer required", 2);
			else if (options.eventType === "plan.proposed") this.attention.notify("Plan ready", 1);
			else if (options.eventType === "turn.completed" && this.isCompletedLiveState(effectiveState)
				&& !this.isCompletedLiveState(previousState)) this.attention.notify("Turn completed", 0);
		}
		this.maybeResetTranscriptScroll(previousState, effectiveState);
		this.queueNativeTranscriptDelta(transcriptAppended);
		this.ui.requestRender();
	}

	replaceSessionState(nextState: MycliShellState): void {
		this.sessionTransitionDepth += 1;
		try {
			this.setState(nextState);
			this.queueNativeTranscriptHistory(true);
		} finally {
			this.sessionTransitionDepth -= 1;
		}
	}

	getState(): MycliShellState {
		return this.state;
	}

	setCommands(commands: MycliShellCommandSpec[], names = commandRoutingNames(commands)): void {
		this.commandCatalog = [...commands];
		this.routingNames = [...names];
		this.refreshAutocompleteProvider();
		for (const entry of this.selectorStack) {
			if (entry.component instanceof CommandPaletteComponent) entry.component.setCommands(commands);
		}
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

	restoreQueuedText(input: MycliShellQueuedInput | string): void {
		this.restoreQueuedInputToEditor(input);
	}

	completeInterruptedTurn(
		queuedInputs: MycliShellQueuedInput[],
		options: { restoreSubmittedInput?: boolean } = {},
	): void {
		const inputs: MycliShellQueuedInput[] = [];
		if (
			options.restoreSubmittedInput !== false &&
			this.lastSubmittedInputEligible &&
			this.lastSubmittedInput
		) {
			this.editor.removeLastFromHistory?.(this.lastSubmittedInput.text);
			inputs.push(this.lastSubmittedInput);
		}
		inputs.push(...queuedInputs);
		this.lastSubmittedInput = null;
		this.lastSubmittedInputEligible = false;
		this.lastSubmittedActivitySignature = "";
		this.userTurnPendingStart = false;
		this.prependQueuedInputs(inputs);
	}

	async shutdown(): Promise<void> {
		this.stop();
		await this.dispatchAction({ type: "exit", reason: "normal" });
	}

	stop(): void {
		this.attention.clear();
		this.clearExitHint();
		for (const entry of this.selectorStack) entry.dispose?.();
		this.selectorStack = [];
		this.stopTurnActivity();
		this.closeTranscriptViewer();
		if (this.nativeResizeTimer) {
			clearTimeout(this.nativeResizeTimer);
			this.nativeResizeTimer = undefined;
		}
		if (this.started) {
			this.ui.stop();
			this.started = false;
		}
		this.ui.setRenderingPaused(false);
	}

	refreshTurnStatus(): void {
		this.rebuildStatus();
		this.ui.requestRender();
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (this.attention.handleInput(data)) return { consume: true };
		if (!matchesKey(data, "ctrl+c")) this.clearExitHint();
		if (this.ui.hasOverlay() || this.selectorActive) {
			return undefined;
		}
		if (matchesKey(data, "shift+tab") && !this.isTurnRunning()) {
			this.cycleCollaborationMode();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			this.runAsyncAction(() => this.handleCtrlC(), "Interrupt request failed");
			return { consume: true };
		}
		if (this.keybindings.matches(data, "app.transcript.open")) {
			this.showTranscriptViewer();
			return { consume: true };
		}
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.toggleToolDetails();
			return { consume: true };
		}
		if (this.keybindings.matches(data, "app.interrupt") && this.isTurnRunning()) {
			this.runAsyncAction(() => this.handleInterrupt(), "Interrupt request failed");
			return { consume: true };
		}
		if (this.ui.terminal.nativeScrollback) {
			return undefined;
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
			this.pendingMessagesContainer.render(width).length +
			this.workStatusContainer.render(width).length +
			this.statusContainer.render(width).length +
			this.editorContainer.render(width).length +
			this.subagentTaskContainer.render(width).length +
			this.footerContainer.render(width).length;
		return Math.max(1, this.ui.terminal.rows - chromeHeight);
	}

	private decisionPanelOptions(): DecisionPanelOptions {
		return {
			onRender: () => this.ui.requestRender(),
			maxHeight: () => {
				if (!this.mainMounted) return this.ui.terminal.rows;
				const width = this.ui.terminal.columns;
				const notice = this.state.pendingNotice && !this.state.pendingApproval && !this.state.pendingClarification;
				const noticeHeight = notice ? 1 + new Text(this.state.pendingNotice!, 1, 0).render(width).length : 0;
				const pending = this.state.pendingInput;
				const hasPending = pending && (pending.pendingSteers.length || pending.rejectedSteers.length || pending.followUps.length);
				// Pending previews already measure the editor; reserve their minimum without recursing into them.
				return Math.max(1, this.ui.terminal.rows
					- this.workStatusContainer.render(width).length
					- this.statusContainer.render(width).length
					- this.subagentTaskContainer.render(width).length
					- this.footerContainer.render(width).length
					- noticeHeight - (hasPending ? 2 : 0) - 1);
			},
		};
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
		const startupGate = !this.mainMounted;
		this.openTrustSelector({
			onPersisted: (trusted, done) => {
				this.patchFooter({ trust: trusted ? "trusted" : "untrusted" });
				if (!startupGate) {
					done();
					return;
				}
				if (!trusted) {
					void this.shutdown();
					return;
				}
				done();
				this.mountMain();
				this.ui.setFocus(this.editor);
			},
			onCancel: (done) => {
				if (startupGate) void this.shutdown();
				else done();
			},
		});
	}

	private showStartupOnboardingStage(): void {
		const stage = this.startupOnboarding?.current();
		if (!stage) {
			this.finishStartupOnboarding();
			return;
		}
		this.ensureSelectorHostMounted();
		switch (stage) {
			case "welcome":
				this.showSelector((done) => {
					const component = new WelcomeStepComponent({
						onContinue: () => this.completeStartupOnboardingStage(stage, done),
						onCancel: () => { void this.shutdown(); },
					});
					return { component, focus: component };
				});
				return;
			case "credential":
				this.showStartupCredentialStage();
				return;
			case "model":
				this.showStartupModelStage();
				return;
			case "connectivity":
				this.showStartupConnectivityStage();
				return;
			case "trust":
				this.showStartupTrustStage();
				return;
			case "permission":
				this.showStartupPermissionStage();
				return;
			case "ready":
				this.showStartupReadyStage();
		}
	}

	private showStartupCredentialStage(): void {
		const readiness = this.state.authReadiness;
		this.showSelector((done) => {
			const selector = new LoginFlowComponent({
				tui: this.ui,
				providers: this.authProviders(),
				...(readiness?.providerId ? { initialProviderId: readiness.providerId } : {}),
				...(readiness?.authRef ? { initialAuthRef: readiness.authRef } : {}),
				onSubmit: ({ providerId, authRef, apiKey }) => {
					void this.submitApiKeyLogin(
						providerId,
						authRef,
						apiKey,
						selector,
						done,
						(savedProviderId) => {
							this.startupProviderId = savedProviderId;
							this.advanceStartupOnboarding("credential");
						},
						false,
					);
				},
				onCancel: () => { void this.shutdown(); },
			});
			return { component: selector, focus: selector };
		});
	}

	private showStartupModelStage(): void {
		const providerId = this.startupProviderId ?? this.state.authReadiness?.providerId;
		if (!this.options.onModelLoad && providerId && this.modelsForProvider(providerId).length === 0) {
			this.advanceStartupOnboarding("model");
			return;
		}
		this.openModelSelector({
			...(providerId ? { preferredProviderId: providerId } : {}),
			lockPreferredProvider: Boolean(providerId),
			...(!this.options.onModelLoad && providerId ? { initialSearchInput: providerId } : {}),
			onSelected: () => this.advanceStartupOnboarding("model"),
			onCancel: () => { void this.shutdown(); },
		});
	}

	private showStartupConnectivityStage(): void {
		this.showSelector((done) => {
			const component = new ConnectivityStepComponent({
				validationAvailable: this.options.onConnectivityValidate !== undefined,
				onSkip: () => this.completeStartupOnboardingStage("connectivity", done),
				onValidate: () => {
					component.setPending(true);
					this.ui.requestRender();
					void Promise.resolve(this.options.onConnectivityValidate?.()).then(
						(result) => {
							if (result && result.ok === false) {
								component.setError(result.message ?? "Unable to reach the selected provider.");
								this.ui.requestRender();
								return;
							}
							this.completeStartupOnboardingStage("connectivity", done);
						},
						(error: unknown) => {
							component.setError(safeErrorMessage(error, "Unable to reach the selected provider."));
							this.ui.requestRender();
						},
					);
				},
				onCancel: () => { void this.shutdown(); },
			});
			return { component, focus: component };
		});
	}

	private showStartupTrustStage(): void {
		this.openTrustSelector({
			onPersisted: (trusted, done) => {
				this.patchFooter({ trust: trusted ? "trusted" : "untrusted" });
				if (!trusted) {
					void this.shutdown();
					return;
				}
				done();
				this.advanceStartupOnboarding("trust");
			},
			onCancel: () => { void this.shutdown(); },
		});
	}

	private showStartupPermissionStage(): void {
		const permissions = this.state.permissions ?? defaultPermissionState();
		this.showSelector((done) => {
			const selector = new PermissionSelectorComponent({
				...this.decisionPanelOptions(),
				permissions,
				showAllowances: false,
				title: "Choose model permissions",
				onSelect: (profile): Promise<void> => {
					return this.submitPermissionSelection(profile, selector, done, () => {
						this.advanceStartupOnboarding("permission");
					}, false);
				},
				onClearAllowances: () => undefined,
				onCancel: () => { void this.shutdown(); },
			});
			return { component: selector, focus: selector };
		});
	}

	private showStartupReadyStage(): void {
		const activePermission = this.state.permissions?.profiles.find((profile) => profile.current);
		this.showSelector((done) => {
			const component = new ReadyStepComponent({
				provider: this.state.currentModel?.provider ?? this.state.footer.provider,
				model: this.state.currentModel?.model ?? this.state.footer.model,
				permission: activePermission?.label,
				trusted: this.state.footer.trust === "trusted",
				onContinue: () => this.completeStartupOnboardingStage("ready", done),
				onCancel: () => { void this.shutdown(); },
			});
			return { component, focus: component };
		});
	}

	private openTrustSelector(options: {
		readonly onPersisted: (trusted: boolean, done: () => void) => void;
		readonly onCancel: (done: () => void) => void;
	}): void {
		this.ensureSelectorHostMounted();
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				...this.decisionPanelOptions(),
				cwd: this.state.footer.cwd,
				savedDecision: trustDecision(this.state.footer.trust) ?? this.options.trustSavedDecision ?? null,
				projectTrusted: this.state.footer.trust === "trusted" || this.options.projectTrusted === true,
				onSelect: async (trusted) => {
					await this.options.onTrustSelect?.(trusted);
					options.onPersisted(trusted, done);
				},
				onCancel: () => options.onCancel(done),
			});
			return { component: selector, focus: selector };
		});
	}

	private completeStartupOnboardingStage(
		stage: StartupOnboardingStage,
		done: () => void,
	): void {
		done();
		this.advanceStartupOnboarding(stage);
	}

	private advanceStartupOnboarding(stage: StartupOnboardingStage): void {
		this.startupOnboarding?.advance(stage);
		queueMicrotask(() => this.showStartupOnboardingStage());
	}

	private finishStartupOnboarding(): void {
		this.startupOnboarding = null;
		this.mountMain();
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	showCommandPalette(): void {
		const commands = this.commands();
		this.showSelector((done) => {
			const palette = new CommandPaletteComponent({
				tui: this.ui,
				commands,
				turnRunning: () => this.isTurnRunning(),
				settingsCatalog: this.state.settingsCatalog,
				onSelect: (command) => {
					done();
					this.runAsyncAction(() => this.submitCommand(command.name), "Command failed");
				},
				onCancel: done,
			});
			return { component: palette, focus: palette };
		});
	}

	showHelp(): void {
		this.showSelector((done) => {
			const help = new HelpOverlayComponent({ commands: this.commands(), onClose: done });
			return { component: help, focus: help };
		});
	}

	showCommandResultOverlay(result: MycliShellCommandResult): void {
		this.showSelector((done) => {
			const overlay = new CommandResultOverlayComponent(result, done, this.decisionPanelOptions());
			return { component: overlay, focus: overlay };
		});
	}

	showTranscriptViewer(): void {
		if (this.transcriptViewer || !this.mainMounted) return;
		const terminal = this.ui.terminal;
		const screen = this.ui.captureScreen();
		const enteredAlternateScreen = terminal.alternateScreen !== true
			&& terminal.enterAlternateScreen !== undefined;
		if (enteredAlternateScreen) terminal.enterAlternateScreen?.();
		const component = new TranscriptViewerComponent({
			blocks: this.transcriptBlocksForState(this.state),
			rows: () => terminal.rows,
			...(this.state.footer.sessionName ? { sessionLabel: this.state.footer.sessionName } : {}),
			hasOlderHistory: Boolean(this.state.transcriptNextBefore || this.state.providerAttemptsNextBefore),
			hasOlderAttempts: Boolean(this.state.providerAttemptsNextBefore),
			onLoadOlder: () => this.loadOlderTranscriptHistory(),
			isToggleKey: (data) => this.keybindings.matches(data, "app.transcript.open"),
			onClose: () => this.closeTranscriptViewer(),
		});
		const handle = this.ui.showOverlay(component, {
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
		});
		this.transcriptViewer = {
			component,
			handle,
			screen,
			enteredAlternateScreen,
			loadingHistory: false,
			blocksSource: this.state.transcript ?? [],
		};
		this.ui.requestRender(true);
	}

	closeTranscriptViewer(): void {
		const viewer = this.transcriptViewer;
		if (!viewer) return;
		this.transcriptViewer = null;
		viewer.handle.hide();
		if (viewer.enteredAlternateScreen) this.ui.terminal.leaveAlternateScreen?.();
		this.ui.restoreScreen(viewer.screen);
		this.queueNativeTranscriptDelta(true);
		this.ui.requestRender();
	}

	async handleClientAction(action: string, args: string): Promise<void> {
		const handlers: Record<string, () => void | Promise<void>> = {
			open_command_palette: () => this.showCommandPalette(),
			open_help: () => this.showHelp(),
			open_model_selector: () => this.showModelSelector(args || undefined),
			open_permissions: () => this.showPermissionSelector(),
			open_settings: () => this.showSettingsSelector(),
			open_session_selector: () => this.showSessionSelector(),
			open_resources: () => this.showResourceSelector(),
			open_review: () => this.showReviewSelector(),
			open_diff: () => this.showWorkspaceDiff(),
			open_rename: () => this.showRenameSelector(),
			open_hooks: () => this.showHooksSelector(),
			open_skills: () => this.showSkillsSelector(),
			open_plugins: () => this.showPluginSelector(),
			open_agents: () => this.showBackgroundSubagents(),
			open_tasks: () => this.showBackgroundSubagents(),
			toggle_details: () => this.toggleToolDetails(),
			set_view_mode: () => this.setViewMode(args),
			open_hotkeys: () => this.showHelp(),
			copy_last_response: () => this.copyLastAssistantMessage(),
			open_login: () => this.showLoginFlow(args || undefined),
			open_trust: () => this.showTrustGate(),
			quit: () => this.shutdown(),
		};
		const handler = handlers[action];
		if (!handler) {
			this.addSystemNotice(`Internal command configuration error: unknown action ${action}`);
			return;
		}
		await handler();
	}

	showModelSelector(initialSearchInput?: string): void {
		const preferredProviderId = this.state.currentModel?.provider ?? this.state.footer.provider;
		this.openModelSelector({
			...(initialSearchInput ? { initialSearchInput } : {}),
			...(preferredProviderId ? { preferredProviderId } : {}),
			lockPreferredProvider: Boolean(initialSearchInput),
		});
	}

	private openModelSelector(options: {
		readonly initialSearchInput?: string;
		readonly preferredProviderId?: string;
		readonly lockPreferredProvider?: boolean;
		readonly onSelected?: () => void;
		readonly onCancel?: () => void;
	}): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent({
					tui: this.ui,
					maxHeight: this.decisionPanelOptions().maxHeight,
					currentModel: this.state.currentModel,
					models: this.state.models ?? [],
					...(options.initialSearchInput ? { initialSearchInput: options.initialSearchInput } : {}),
				...(options.preferredProviderId ? { preferredProviderId: options.preferredProviderId } : {}),
				lockPreferredProvider: options.lockPreferredProvider === true,
				...(this.options.onProviderLoad ? { onProviderLoad: this.options.onProviderLoad } : {}),
				...(this.options.onModelLoad ? { onModelLoad: this.options.onModelLoad } : {}),
				onProvidersLoaded: (providerRoutes) => {
					if (this.options.onProviderRoutesChange) {
						this.options.onProviderRoutesChange(providerRoutes);
					} else {
						this.setState({ ...this.state, providerRoutes });
					}
				},
				onModelsLoaded: (providerId, models) => {
					if (this.options.onModelCatalogChange) {
						this.options.onModelCatalogChange(providerId, models);
					} else {
						this.setState({ ...this.state, models, modelsProvider: providerId });
					}
				},
				onLoginRequired: (provider) => {
					this.showLoginFlow(provider.id, provider.authRef, false, (savedProviderId) => {
						selector.refreshProviders(savedProviderId);
					}, true);
				},
				onSelect: (model, scope) => {
					void this.submitModelSelection(model, scope, selector, done, options.onSelected);
				},
				onCancel: () => {
					done();
					options.onCancel?.();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	showPermissionSelector(): void {
		const permissions = this.state.permissions ?? defaultPermissionState();
		this.showSelector((done) => {
			const selector = new PermissionSelectorComponent({
				...this.decisionPanelOptions(),
				permissions,
				onSelect: (profile): Promise<void> => {
					return this.submitPermissionSelection(profile, selector, done);
				},
				onClearAllowances: (): Promise<void> => {
					return this.clearPermissionAllowances(selector, done);
				},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	showLoginFlow(
		initialProviderId?: string,
		initialAuthRef?: string,
		exitOnCancel = false,
		onSuccess?: (providerId: string) => void,
		returnOnBack = false,
	): void {
		this.ensureSelectorHostMounted();
		this.showSelector((done) => {
			const selector = new LoginFlowComponent({
				tui: this.ui,
				providers: this.authProviders(),
				...(initialProviderId ? { initialProviderId } : {}),
				...(initialAuthRef ? { initialAuthRef } : {}),
				...(returnOnBack ? { onBack: done } : {}),
				onSubmit: ({ providerId, authRef, apiKey }) => {
					void this.submitApiKeyLogin(
						providerId,
						authRef,
						apiKey,
						selector,
						done,
						onSuccess,
					);
				},
				onCancel: () => {
					if (exitOnCancel) {
						void this.shutdown();
						return;
					}
					done();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	async showSettingsSelector(): Promise<void> {
		const loaded = await this.options.onSettingsLoad?.();
		if (loaded) {
			const loadedState = this.ensureToolsVisible({
				...this.state,
				settings: loaded.settings,
				settingsCatalog: loaded.catalog ?? this.state.settingsCatalog,
				keymap: loaded.keymap ?? this.state.keymap,
				terminalCapabilities: loaded.terminalCapabilities ?? this.state.terminalCapabilities,
			});
			this.setState(loadedState);
		}
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent({
				tui: this.ui,
				settings: this.state.settings,
				catalog: this.state.settingsCatalog,
				onAction: (item, activeSelector) => this.openSettingsAction(item, activeSelector),
				onChange: (item, value, scope, activeSelector) => {
					void this.applySettingsChange(item, value, scope, activeSelector);
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
				onPreview: this.options.onSessionConversationPreview ? (session) => this.showTextViewer(`Conversation · ${session.title ?? session.id}`, (signal) => this.options.onSessionConversationPreview!(session.id, signal)) : undefined,
				onSelect: (session) => {
					void this.prepareSessionResume(session, selector, done);
				},
				onCancel: () => done(),
			});
			if (this.options.onSessionLoad) {
				selector.setLoading();
				void this.loadSessionSelector(selector);
			}
			return { component: selector, focus: selector };
		});
	}

	private async loadSessionSelector(selector: SessionSelectorComponent): Promise<void> {
		const revision = this.sessionRevision;
		const isCurrent = (): boolean => revision === this.sessionRevision
			&& this.selectorStack.some((entry) => entry.component === selector);
		try {
			const sessions = await this.options.onSessionLoad?.();
			if (sessions && isCurrent()) selector.setSessions(sessions);
		} catch (error) {
			if (isCurrent()) selector.setError(safeErrorMessage(error, "Unable to load sessions."));
		}
	}

	private async prepareSessionResume(
		session: MycliShellSession,
		selector: SessionSelectorComponent,
		done: () => void,
	): Promise<void> {
		try {
			const preview = await this.options.onSessionResumePreview?.(session.id);
			if (preview && !preview.ready) {
				if (preview.actions.length === 0) {
					selector.setError(resumeBlockedMessage(preview));
					return;
				}
				done();
				this.showSessionRepairSelector(preview);
				return;
			}
			const remaining = await this.selectSession(session.id);
			if (remaining && !remaining.ready) {
				done();
				this.showSessionRepairSelector(remaining);
				return;
			}
			done();
			this.queueNativeTranscriptHistory(true);
		} catch (error) {
			selector.setError(safeErrorMessage(error, "Unable to resume this session."));
		}
	}

	private showSessionRepairSelector(preview: MycliShellResumeRepairPreview): void {
		this.showSelector((done) => {
			const selector = new SessionRepairSelectorComponent({
				...this.decisionPanelOptions(),
				preview,
				onSelect: async (action) => {
					const remaining = await this.selectSession(preview.session.id, {
						action,
						metadataRevision: preview.session.metadataRevision ?? 0,
					});
					done();
					if (remaining && !remaining.ready) {
						this.showSessionRepairSelector(remaining);
						return;
					}
					this.queueNativeTranscriptHistory(true);
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

	showReviewSelector(): void {
		if (this.isTurnRunning()) { this.addSystemNotice("Wait for the current turn before starting a review."); return; }
		this.showSelector((done) => {
			const component = new ReviewSelectorComponent({ ...this.decisionPanelOptions(), onCancel: done,
				onSelect: async (review, signal) => {
					signal.throwIfAborted();
					const text = review.kind === "uncommitted" ? "Review uncommitted changes." : review.kind === "custom" ? `Review: ${review.instructions}` : `Review ${review.kind === "base" ? "changes against" : "commit"} ${review.ref}.`;
					await this.dispatchAction({ type: "submit", text, review, signal });
					if (!signal.aborted) done();
				},
			});
			return { component, focus: component, dispose: () => component.dispose() };
		});
	}

	showWorkspaceDiff(): void {
		const load = this.options.onWorkspaceDiffLoad;
		if (!load) { this.addSystemNotice("Git diff is unavailable."); return; }
		this.showTextViewer("Git diff", load, true);
	}

	private showTextViewer(title: string, load: (signal: AbortSignal) => Promise<string>, diff = false): void {
		this.showSelector((done) => {
			const component = new TextViewerSelectorComponent({ ...this.decisionPanelOptions(), title, load, diff, onCancel: done });
			return { component, focus: component, dispose: () => component.dispose() };
		});
	}

	showRenameSelector(): void {
		this.showSelector((done) => {
			const component = new TextEntrySelectorComponent({ ...this.decisionPanelOptions(), title: "Rename session", description: "Enter a title for this conversation.", initialValue: this.state.footer.sessionName ?? "", maxLength: 200, onCancel: done,
				onSubmit: async (value, signal) => { signal.throwIfAborted(); await this.dispatchAction({ type: "command", command: `/rename ${value}` }); if (!signal.aborted) done(); },
			});
			return { component, focus: component, dispose: () => component.dispose() };
		});
	}

	showHooksSelector(): void {
		const manager = this.options.hookManager;
		if (!manager) { this.addSystemNotice("Hook management is unavailable."); return; }
		this.showSelector((done) => {
			const selector = new HooksSelectorComponent({ ...this.decisionPanelOptions(), manager, onCancel: done });
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	showSkillsSelector(): void {
		const manager = this.options.skillManager;
		if (!manager) { this.addSystemNotice("Skill management is unavailable."); return; }
		this.showSelector((done) => {
			const selector = new SkillsSelectorComponent({ ...this.decisionPanelOptions(), manager, onCancel: done,
				onSelect: (skill) => {
					done();
					const retained = skillReferencesInText(this.skillReferences, this.editor.getText()).filter((item) => item.name !== skill.name);
					if (retained.length >= MAX_SKILL_REFERENCES) { this.addSystemNotice(`Select at most ${MAX_SKILL_REFERENCES} skills per message.`); return; }
					this.skillReferences = [...retained, { id: skill.id, name: skill.name, revision: skill.revision }];
					this.editor.insertTextAtCursor(`$${skill.name} `);
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
		});
	}

	showPluginSelector(): void {
		const manager = this.options.pluginManager;
		if (!manager) { this.addSystemNotice("Plugin management is unavailable."); return; }
		this.showSelector((done) => {
			const selector = new PluginSelectorComponent({ ...this.decisionPanelOptions(), manager, onCancel: done });
			return { component: selector, focus: selector, dispose: () => selector.dispose() };
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
					this.runAsyncAction(() => this.inspectResource(resource), "Command failed");
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
					this.runAsyncAction(() => this.submitCommand(`/agents kill ${childSessionId}`), "Command failed");
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
		this.ui.addChild(this.transcriptArea);
		this.ui.addChild(this.workStatusContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.subagentTaskContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.footerContainer);
		this.rebuildAll();
		this.queueNativeTranscriptHistory();
	}

	private queueNativeTranscriptHistory(replaceScrollback = false): void {
		if (!this.ui.terminal.nativeScrollback) return;
		const heldTail = this.nativeScrollbackHeldTail();
		if (heldTail) {
			this.nativeTranscriptDeltaHeld = true;
			this.transcriptViewport.discardPendingScrollbackLines();
			const prefix = this.transcriptViewport.scrollbackPrefixBefore(
				this.chatContainer,
				heldTail.componentIndex,
				this.ui.terminal.columns,
			);
			this.ui.insertHistoryBeforeNextFrame(prefix, {
				clearViewport: true,
				replaceScrollback,
			});
			return;
		}
		this.nativeTranscriptDeltaHeld = false;
		const prefix = this.transcriptViewport.scrollbackPrefix(this.ui.terminal.columns);
		this.ui.insertHistoryBeforeNextFrame(prefix, {
			clearViewport: true,
			replaceScrollback,
		});
	}

	private handleTerminalResize(): boolean {
		const transcriptMounted = this.ui.children.includes(this.transcriptArea);
		if (!this.ui.terminal.nativeScrollback || !transcriptMounted) {
			return false;
		}
		if (this.nativeResizeTimer) {
			clearTimeout(this.nativeResizeTimer);
		}
		this.ui.setRenderingPaused(true);
		this.nativeResizeTimer = setTimeout(() => {
			this.nativeResizeTimer = undefined;
			if (!this.started) {
				this.ui.setRenderingPaused(false);
				return;
			}
			this.queueNativeTranscriptHistory(true);
			this.ui.setRenderingPaused(false);
		}, NATIVE_RESIZE_REFLOW_DEBOUNCE_MS);
		this.nativeResizeTimer.unref?.();
		return true;
	}

	private queueNativeTranscriptDelta(refreshLines = false): void {
		if (this.sessionTransitionDepth > 0) return;
		if (!this.ui.terminal.nativeScrollback || !this.mainMounted) return;
		if (this.nativeScrollbackHeldTail()) {
			this.nativeTranscriptDeltaHeld = true;
			this.transcriptViewport.discardPendingScrollbackLines();
			return;
		}
		if (this.nativeTranscriptDeltaHeld) {
			this.nativeTranscriptDeltaHeld = false;
			this.queueNativeTranscriptHistory(true);
			return;
		}
		const delta = this.transcriptViewport.takeNewScrollbackLines(this.ui.terminal.columns, refreshLines);
		if (delta.length > 0) {
			this.ui.insertHistoryBeforeNextFrame(delta, { clearViewport: !this.isTurnRunning() });
		}
	}

	private nativeScrollbackHeldTail(): { componentIndex: number } | null {
		if (!this.isTurnRunning()) return null;
		const tail = this.projectedChatBlocks.at(-1);
		if (tail?.kind !== "message" || tail.message.role !== "assistant") return null;
		const component = this.chatBlocks.get(tail.id)?.component;
		if (!(component instanceof AssistantMessageComponent) || !component.holdsNativeScrollbackTail()) {
			return null;
		}
		const componentIndex = this.chatContainer.children.indexOf(component);
		return componentIndex < 0 ? null : { componentIndex };
	}

	private transcriptBlockCount(state: MycliShellState): number {
		return state.transcript?.length ?? state.messages.length + state.tools.length + state.bash.length;
	}

	private showSelector(create: (done: () => void) => SelectorEntry): void {
		let entry: SelectorEntry | undefined;
		const done = () => this.closeSelector(entry);
		entry = create(done);
		this.selectorStack.push(entry);
		this.mountSelector(entry);
	}

	private closeSelector(entry: SelectorEntry | undefined): void {
		if (!entry || this.selectorStack.at(-1) !== entry) return;
		this.selectorStack.pop();
		entry.dispose?.();
		const previous = this.selectorStack.at(-1);
		if (previous) {
			this.mountSelector(previous);
			return;
		}
		this.restoreEditor();
	}

	private mountSelector(entry: SelectorEntry): void {
		this.selectorActive = true;
		this.editorContainer.clear();
		this.editorContainer.addChild(entry.component);
		this.ui.setFocus(entry.focus);
		this.ui.requestRender();
	}

	private restoreEditor(): void {
		this.selectorActive = false;
		for (const entry of this.selectorStack) entry.dispose?.();
		this.selectorStack = [];
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private ensureSelectorHostMounted(): void {
		if (this.mainMounted || this.ui.children.includes(this.editorContainer)) {
			return;
		}
		this.ui.addChild(this.editorContainer);
	}

	private replaceSelectorHostWithMain(): void {
		if (
			this.ui.children.length === 1 &&
			this.ui.children[0] === this.editorContainer
		) {
			this.ui.clear();
		}
	}

	private rebuildAll(): void {
		this.rebuildHeader();
		this.rebuildChat();
		this.rebuildStatus();
		this.rebuildSubagentTasks();
		this.rebuildWorkStatus();
		this.rebuildFooter();
		this.rebuildPending();
		this.syncPendingSurface(null, this.state);
	}

	private rebuildForVisualSettings(): void {
		this.stopTurnActivity();
		this.chatBlocks.clear();
		this.projectedChatBlocks = [];
		this.transcriptProjection = null;
		this.rebuildAll();
		this.ui.invalidate();
	}

	private applyVisualSettings(
		settings: MycliShellVisualSettings | undefined,
		capabilities: MycliShellState["terminalCapabilities"],
	): void {
		if (settings?.theme === "dark" || settings?.theme === "light") {
			theme.setName(settings.theme);
		}
		const colorMode = capabilities?.colorForcedOff
			? "none"
			: settings?.colorMode && settings.colorMode !== "auto"
				? settings.colorMode
				: capabilities?.colorMode;
		if (colorMode) theme.setColorMode(colorMode);
		theme.setHighContrast(settings?.highContrast ?? capabilities?.highContrast ?? false);
		const glyphMode = settings?.glyphMode && settings.glyphMode !== "auto"
			? settings.glyphMode
			: capabilities?.glyphMode;
		if (glyphMode) setUiGlyphMode(glyphMode);
		if (settings?.hardwareCursor !== undefined) {
			this.ui.setShowHardwareCursor(settings.hardwareCursor);
		}
		if (settings?.clearOnShrink !== undefined) {
			this.ui.setClearOnShrink(settings.clearOnShrink);
		}
	}

	private settingsSignature(state: MycliShellState): string {
		return JSON.stringify({
			settings: state.settings ?? {},
			keymap: state.keymap ?? null,
			terminalCapabilities: state.terminalCapabilities ?? null,
		});
	}

	private rebuildChangedSections(
		previousState: MycliShellState,
		nextState: MycliShellState,
		transcriptUpdate?: TranscriptUpdateKind,
	): void {
		if ((previousState.title ?? "mycli") !== (nextState.title ?? "mycli")) {
			this.rebuildHeader();
		}
		const completionChanged =
			this.isCompletedLiveState(previousState) !==
			this.isCompletedLiveState(nextState);
		const chatUpdate = this.resolveChatUpdate(previousState, nextState, transcriptUpdate);
		if (completionChanged || chatUpdate !== "unchanged") {
			this.rebuildChat(chatUpdate === "tail" && !completionChanged);
		}
		if (
			previousState.pendingNotice !== nextState.pendingNotice ||
			this.pendingInputSignature(previousState) !== this.pendingInputSignature(nextState) ||
			this.pendingSurfaceSignature(previousState) !== this.pendingSurfaceSignature(nextState)
		) {
			this.rebuildPending();
		}
		const liveStateChanged = this.liveStateSignature(previousState) !== this.liveStateSignature(nextState);
		if (liveStateChanged) {
			this.rebuildStatus();
		}
		if (this.subagentTasksChanged(previousState, nextState, transcriptUpdate)) {
			this.rebuildSubagentTasks();
		}
		if (this.workStatusSignature(previousState) !== this.workStatusSignature(nextState)) {
			this.rebuildWorkStatus();
		}
		if (this.footerSignature(previousState) !== this.footerSignature(nextState)) {
			this.rebuildFooter();
		}
		this.syncPendingSurface(previousState, nextState);
	}

	private resolveChatUpdate(
		previousState: MycliShellState,
		nextState: MycliShellState,
		hint?: TranscriptUpdateKind,
	): TranscriptUpdateKind {
		if (
			previousState.messages === nextState.messages &&
			previousState.tools === nextState.tools &&
			previousState.bash === nextState.bash &&
			previousState.transcript === nextState.transcript
		) {
			return "unchanged";
		}
		if (hint) return hint;
		return this.chatSignature(previousState) === this.chatSignature(nextState)
			? "unchanged"
			: "replace";
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
			turnRunning: state.footer.turnRunning,
			liveState: state.footer.liveState,
			liveStateKind: state.footer.liveStateKind,
			liveStateDetail: state.footer.liveStateDetail,
			liveRetryAt: state.footer.liveRetryAt,
			turnStartedAtMs: this.turnStartedAtMs,
		});
	}

	private footerSignature(state: MycliShellState): string {
		const footer = state.footer;
		return JSON.stringify({
			cwd: footer.cwd,
			gitBranch: footer.gitBranch,
			sessionName: footer.sessionName,
			model: footer.model,
			reasoningLevel: footer.reasoningLevel,
			contextPercent: footer.contextPercent,
			contextSource: footer.contextSource,
			trust: footer.trust,
			collaborationMode: footer.collaborationMode,
		});
	}

	private workStatusSignature(state: MycliShellState): string {
		return JSON.stringify({
			activityVisible: this.isTurnActivityVisible(state),
			goal: state.footer.goal,
			backgroundShellCount: state.footer.backgroundShellCount,
			extensionStatuses: state.footer.extensionStatuses,
		});
	}

	private pendingSurfaceSignature(state: MycliShellState): string {
		return JSON.stringify({
			approval: state.pendingApproval ?? null,
			clarification: state.pendingClarification ?? null,
		});
	}

	private pendingInputSignature(state: MycliShellState): string {
		return JSON.stringify(state.pendingInput ?? null);
	}

	private subagentTaskSignature(state: MycliShellState): string {
		return JSON.stringify({
			transcript: state.transcript?.filter((block) => block.kind === "subagent") ?? [],
			dismissed: [...this.dismissedSubagentIds].sort(),
			density: state.settings?.subagentDensity ?? "normal",
		});
	}

	private subagentTasksChanged(
		previousState: MycliShellState,
		nextState: MycliShellState,
		transcriptUpdate?: TranscriptUpdateKind,
	): boolean {
		if (transcriptUpdate === "unchanged") return false;
		if (transcriptUpdate === "tail") {
			const previousTail = previousState.transcript?.at(-1);
			const nextTail = nextState.transcript?.at(-1);
			if (previousTail?.kind !== "subagent" && nextTail?.kind !== "subagent") return false;
		}
		return this.subagentTaskSignature(previousState) !== this.subagentTaskSignature(nextState);
	}

	private syncPendingSurface(previousState: MycliShellState | null, nextState: MycliShellState): void {
		if (previousState && this.pendingSurfaceSignature(previousState) === this.pendingSurfaceSignature(nextState)) {
			return;
		}
		if (nextState.pendingApproval) {
			this.clarificationSurfaceRequestId = null;
			this.showApprovalSelector(nextState.pendingApproval);
			return;
		}
		if (nextState.pendingClarification) {
			this.approvalSurfaceDecisionId = null;
			this.showClarificationSelector(nextState.pendingClarification);
			return;
		}
		if (this.approvalSurfaceDecisionId !== null || this.clarificationSurfaceRequestId !== null) {
			this.approvalSurfaceDecisionId = null;
			this.clarificationSurfaceRequestId = null;
			this.restoreEditor();
		}
	}

	private maybeShowPlanImplementation(eventType: string | undefined): void {
		if (
			eventType !== "plan.proposed"
			|| !this.mainMounted
			|| this.selectorActive
			|| this.transcriptViewer !== null
			|| this.state.footer.collaborationMode !== "plan"
			|| this.state.pendingApproval !== undefined
			|| this.state.pendingClarification !== undefined
			|| this.hasQueuedInput()
		) {
			return;
		}
		const plan = [...(this.state.transcript ?? [])]
			.reverse()
			.find((block) => block.kind === "plan" && block.plan.status === "proposed");
		if (!plan || plan.kind !== "plan" || !plan.plan.text.trim()) return;
		const contextUsageLabel = planImplementationContextUsageLabel(
			this.state.footer.contextPercent,
			this.state.footer.contextUsedTokens,
		);

		this.showSelector((done) => {
			const selector = new PlanImplementationSelectorComponent({
				...this.decisionPanelOptions(),
				...(contextUsageLabel ? { contextUsageLabel } : {}),
				onSelect: async (choice) => {
					if (choice !== "stay") {
						await this.startPlanImplementation(choice, plan.plan.text);
					}
					done();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private async startPlanImplementation(
		action: PlanImplementationAction,
		planMarkdown: string,
	): Promise<void> {
		if (this.options.onPlanImplementation) {
			await this.options.onPlanImplementation(action, planMarkdown);
			return;
		}
		if (!this.options.actions && (!this.options.onCommandSubmit || !this.options.onSubmit)) {
			throw new Error("Plan implementation is unavailable.");
		}
		if (action === "clear_context") {
			await this.dispatchAction({ type: "command", command: "/new" });
		}
		await this.dispatchAction({ type: "command", command: "/mode default" });
		await this.dispatchAction({
			type: "submit",
			text: planImplementationMessage(action, planMarkdown),
		});
	}

	private showApprovalSelector(approval: MycliShellPendingApproval): void {
		const selector = new ApprovalSelectorComponent({
			...this.decisionPanelOptions(),
			approval,
			onSelect: (choice) => this.respondApproval(approval, choice),
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

	private async respondApproval(approval: MycliShellPendingApproval, choice: string): Promise<void> {
		await this.dispatchAction({ type: "approval.respond", approval, choice });
	}

	private showClarificationSelector(clarification: MycliShellPendingClarification): void {
		const selector = clarification.elicitation ? new McpElicitationSelectorComponent({
			...this.decisionPanelOptions(), request: clarification.elicitation,
			onRespond: (response) => this.respondClarification(clarification, response),
		}) : new ClarificationSelectorComponent({
			...this.decisionPanelOptions(),
			clarification,
			onRespond: (response) => this.respondClarification(clarification, response),
			onCancel: () => {
				this.runAsyncAction(() => this.handleInterrupt(), "Interrupt request failed");
			},
		});
		this.clarificationSurfaceRequestId = clarification.requestId;
		this.selectorActive = true;
		this.editorContainer.clear();
		this.editorContainer.addChild(selector);
		this.ui.setFocus(selector);
	}

	private async respondClarification(
		clarification: MycliShellPendingClarification,
		response: string,
	): Promise<void> {
		await this.dispatchAction({ type: "clarification.respond", clarification, response });
	}

	private rebuildHeader(): void {
		this.transcriptRenderRevision += 1;
		this.transcriptViewport.markContentChanged();
		this.headerContainer.clear();
		const title = this.state.title ?? "mycli";
		this.headerContainer.addChild(new Text(
			`${theme.fg("accent", theme.bold(title))} ${theme.fg("muted", rawKeyHint("?", "help"))}`,
			0,
			0,
		));
	}

	private rebuildChat(tailOnly = false): void {
		this.transcriptRenderRevision += 1;
		const transcript = this.state.transcript?.length ? this.state.transcript : this.legacyTranscriptBlocks();
		const stablePrefixLength = this.syncChatBlocks(transcript, tailOnly);
		if (tailOnly) {
			this.transcriptViewport.markSectionTailChanged(this.chatContainer, stablePrefixLength);
		} else {
			this.transcriptViewport.markContentChanged();
		}
	}

	private legacyTranscriptBlocks(): MycliShellTranscriptBlock[] {
		return this.transcriptBlocksForState(this.state);
	}

	private transcriptBlocksForState(state: MycliShellState): MycliShellTranscriptBlock[] {
		if (state.transcript?.length) return state.transcript;
		const blocks: MycliShellTranscriptBlock[] = [];
		for (const message of state.messages) {
			blocks.push({ id: message.id, kind: "message", message });
		}
		for (const tool of state.tools) {
			blocks.push({ id: tool.id, kind: "tool", tool });
		}
		for (const bash of state.bash) {
			blocks.push({ id: bash.id, kind: "bash", bash });
		}
		return blocks;
	}

	private updateTranscriptViewer(state: MycliShellState): void {
		const viewer = this.transcriptViewer;
		if (!viewer) return;
		const blocks = this.transcriptBlocksForState(state);
		const source = state.transcript ?? blocks;
		if (viewer.blocksSource !== source) {
			const prepended = transcriptBlocksWerePrepended(viewer.blocksSource, source);
			viewer.blocksSource = source;
			viewer.component.updateBlocks(blocks, { preserveScrollOffset: prepended });
		}
		viewer.component.setOlderHistoryState({
			available: Boolean(state.transcriptNextBefore || state.providerAttemptsNextBefore),
			retryHistoryAvailable: Boolean(state.providerAttemptsNextBefore),
			loading: viewer.loadingHistory,
		});
	}

	private loadOlderTranscriptHistory(): void {
		const viewer = this.transcriptViewer;
		const before = this.state.transcriptNextBefore ?? "";
		const load = this.options.onTranscriptHistoryLoad;
		if (!viewer || (!before && !this.state.providerAttemptsNextBefore) || !load || viewer.loadingHistory) return;
		viewer.loadingHistory = true;
		viewer.component.setError(undefined);
		viewer.component.setOlderHistoryState({ available: true, loading: true,
			retryHistoryAvailable: Boolean(this.state.providerAttemptsNextBefore) });
		this.ui.requestRender();
		void Promise.resolve(load(before)).catch(() => {
			if (this.transcriptViewer !== viewer) return;
			viewer.component.setError("Earlier transcript history could not be loaded.");
		}).finally(() => {
			if (this.transcriptViewer !== viewer) return;
			viewer.loadingHistory = false;
			viewer.component.setOlderHistoryState({
				available: Boolean(this.state.transcriptNextBefore || this.state.providerAttemptsNextBefore),
				retryHistoryAvailable: Boolean(this.state.providerAttemptsNextBefore),
				loading: false,
			});
			this.ui.requestRender();
		});
	}

	private syncChatBlocks(blocks: MycliShellTranscriptBlock[], tailOnly: boolean): number {
		const projectionUpdate = tailOnly && this.transcriptProjection
			? projectTranscriptTail(blocks, this.transcriptProjection)
			: {
				projection: createTranscriptProjection(blocks),
				stablePrefixLength: 0,
				replacedBlocks: this.projectedChatBlocks,
			};
		const projected = projectionUpdate.projection.blocks;
		const prefixLength = projectionUpdate.stablePrefixLength;
		const nextSuffixIds = new Set<string>();
		for (let index = prefixLength; index < projected.length; index += 1) {
			nextSuffixIds.add(projected[index]!.id);
		}
		for (const block of projectionUpdate.replacedBlocks) {
			if (!nextSuffixIds.has(block.id)) this.chatBlocks.delete(block.id);
		}

		const suffixComponents: Component[] = [];
		for (let index = prefixLength; index < projected.length; index += 1) {
			const block = projected[index]!;
			const cached = this.chatBlocks.get(block.id);
			const next = syncTranscriptBlock(block, cached, {
				hideThinking: this.state.settings?.hideThinking,
				now: this.now,
			});
			this.chatBlocks.set(block.id, next);
			suffixComponents.push(next.component);
		}
		const children = this.chatContainer.children;
		let suffixMatches = children.length === prefixLength + suffixComponents.length;
		for (let index = 0; suffixMatches && index < suffixComponents.length; index += 1) {
			suffixMatches = children[prefixLength + index] === suffixComponents[index];
		}
		if (!suffixMatches) {
			children.splice(prefixLength, children.length - prefixLength, ...suffixComponents);
		}
		this.transcriptProjection = projectionUpdate.projection;
		this.projectedChatBlocks = projected;
		return prefixLength;
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
		let lineIndex = this.headerContainer.render(this.ui.terminal.columns).length;
		for (const child of this.chatContainer.children) {
			const matched = this.chatBlocks.get(blockId);
			if (matched?.component === child) {
				return lineIndex;
			}
			lineIndex += child.render(this.ui.terminal.columns).length;
		}
		return null;
	}

	private createTurnActivityComponent(): TurnActivityComponent {
		if (this.turnStartedAtMs === null && !this.state.footer.operationRunning) this.turnStartedAtMs = this.now();
		const startedAtMs = this.operationStartedAtMs ?? this.turnStartedAtMs ?? this.now();
		this.turnActivity = new TurnActivityComponent(
			this.ui,
			startedAtMs,
			this.now,
			{
				text: this.state.footer.liveState ?? "Running",
				kind: this.state.footer.liveStateKind,
				detail: this.state.footer.liveStateDetail,
				retryAt: this.state.footer.liveRetryAt,
			},
			!(this.state.settings?.reducedMotion
				?? this.state.terminalCapabilities?.reducedMotion
				?? false),
		);
		return this.turnActivity;
	}

	private syncTurnActivityComponent(): TurnActivityComponent | null {
		if (!this.isTurnActivityVisible(this.state)) {
			this.stopTurnActivity();
			return null;
		}
		const activity = this.turnActivity ?? this.createTurnActivityComponent();
		activity.updateStatus({
			text: this.state.footer.liveState ?? "Running",
			kind: this.state.footer.liveStateKind,
			detail: this.state.footer.liveStateDetail,
			retryAt: this.state.footer.liveRetryAt,
		}, this.operationStartedAtMs ?? this.turnStartedAtMs ?? this.now());
		return activity;
	}

	private rebuildPending(): void {
		this.pendingMessagesContainer.clear();
		if (this.state.pendingNotice && !this.state.pendingApproval && !this.state.pendingClarification) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			this.pendingMessagesContainer.addChild(new Text(theme.fg("warning", this.state.pendingNotice), 1, 0));
		}
		const pendingInput = this.state.pendingInput;
		if (
			pendingInput &&
			(
				pendingInput.pendingSteers.length > 0 ||
				pendingInput.rejectedSteers.length > 0 ||
				pendingInput.followUps.length > 0
			)
		) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			this.pendingMessagesContainer.addChild(new PendingInputPreviewComponent(pendingInput, {
				maxHeight: () => this.pendingInputMaxHeight(this.ui.terminal.columns),
			}));
		}
	}

	private pendingInputMaxHeight(width: number): number {
		const noticeHeight = this.state.pendingNotice && !this.state.pendingApproval && !this.state.pendingClarification
			? 1 + new Text(theme.fg("warning", this.state.pendingNotice), 1, 0).render(width).length
			: 0;
		const fixedChromeHeight =
			this.workStatusContainer.render(width).length +
			this.statusContainer.render(width).length +
			this.editorContainer.render(width).length +
			this.subagentTaskContainer.render(width).length +
			this.footerContainer.render(width).length;
		return Math.max(
			1,
			this.ui.terminal.rows - fixedChromeHeight - noticeHeight - 2,
		);
	}

	private rebuildStatus(): void {
		this.statusContainer.clear();
		const activity = this.syncTurnActivityComponent();
		if (activity) {
			this.statusContainer.addChild(activity);
			return;
		}
		if (this.isTurnActivityRunning(this.state)) {
			return;
		}
		if (this.isCompletedLiveState(this.state)) {
			return;
		}
		if (this.state.footer.liveState && this.state.footer.liveState !== "Idle") {
			this.statusContainer.addChild(new StatusMessageComponent(this.state.footer.liveState));
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
				density: this.state.settings?.subagentDensity ?? "normal",
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
		const operationKey = (state: MycliShellState): string | undefined => state.footer.liveOperationId
			?? (state.footer.liveStateKind === "compaction" ? "compaction" : undefined);
		if (operationKey(previousState) !== operationKey(nextState) || previousState.sessionId !== nextState.sessionId) {
			this.operationStartedAtMs = operationKey(nextState) ? this.now() : null;
		}
		const wasRunning = this.isTurnActivityRunning(previousState);
		const isRunning = this.isTurnActivityRunning(nextState);
		if (!wasRunning && isRunning) {
			this.turnStartedAtMs = this.now();
			return;
		}
		if (wasRunning && !isRunning) {
			this.turnStartedAtMs = null;
		}
	}

	private isRunningLiveState(
		liveState: string | undefined,
		liveStateKind?: string,
	): boolean {
		const normalizedKind = liveStateKind?.trim().toLowerCase() ?? "";
		if (["running", "thinking", "streaming", "interrupting", "reconnecting"].includes(normalizedKind)) {
			return true;
		}
		const normalized = liveState?.trim().toLowerCase() ?? "";
		return normalized === "running" || normalized === "thinking" || normalized === "streaming" || normalized === "interrupting";
	}

	private isTurnActivityRunning(state: MycliShellState): boolean {
		return state.footer.operationRunning || (state.footer.turnRunning ?? this.isRunningLiveState(
			state.footer.liveState,
			state.footer.liveStateKind,
		));
	}

	private isTurnActivityVisible(state: MycliShellState): boolean {
		return (state.settings?.terminalProgress
			?? state.terminalCapabilities?.progressVisible
			?? true)
			&& this.isTurnActivityRunning(state);
	}

	private isCompletedLiveState(state: MycliShellState): boolean {
		return state.footer.liveStateKind?.trim().toLowerCase() === "completed"
			|| state.footer.liveState?.trim().toLowerCase() === "completed";
	}

	private visibleTurnActivitySignature(state: MycliShellState): string {
		const activity = new Map<string, unknown>();
		for (const message of state.messages) {
			if (message.role === "assistant") activity.set(`message:${message.id}`, message);
		}
		for (const tool of state.tools) activity.set(`tool:${tool.id}`, tool);
		for (const bash of state.bash) activity.set(`bash:${bash.id}`, bash);
		for (const block of state.transcript ?? []) {
			if (block.kind === "message" && block.message.role === "assistant") {
				activity.set(`message:${block.id}`, block.message);
			} else if (block.kind === "tool") {
				activity.set(`tool:${block.id}`, block.tool);
			} else if (block.kind === "bash") {
				activity.set(`bash:${block.id}`, block.bash);
			} else if (block.kind === "file_change") {
				activity.set(`file_change:${block.id}`, block.fileChange);
			} else if (block.kind === "plan") {
				activity.set(`plan:${block.id}`, block.plan);
			} else if (block.kind === "plan_update") {
				activity.set(`plan_update:${block.id}`, block.planUpdate);
			} else if (block.kind === "clarification") {
				activity.set(`clarification:${block.id}`, block.clarification);
			} else if (block.kind === "subagent") {
				activity.set(`subagent:${block.id}`, block.subagent);
			}
		}
		return JSON.stringify([...activity.entries()].sort(([left], [right]) => left.localeCompare(right)));
	}

	private stopTurnActivity(): void {
		this.turnActivity?.stop();
		this.turnActivity = null;
	}

	private rebuildFooter(): void {
		this.footerContainer.clear();
		const statusbarMode = this.state.settings?.statusbarMode ?? "full";
		if (statusbarMode === "off" && !this.exitHintVisible) return;
		this.footerContainer.addChild(new FooterComponent({ ...this.state.footer, transientHint: this.exitHintVisible ? "Press Ctrl+C again to exit." : undefined }, { statusbarMode }));
	}

	private rebuildWorkStatus(): void {
		this.workStatusContainer.clear();
		this.workStatusContainer.addChild(new WorkStatusComponent(this.state.footer, {
			leadingSpace: !this.isTurnActivityVisible(this.state),
		}));
	}

	private async handleSubmit(text: string, draft: ComposerDraft): Promise<void> {
		const sessionId = this.state.sessionId;
		const input = text.trim();
		const planTask = /^\/plan\s+([\s\S]+)$/u.exec(input)?.[1];
		if (planTask && this.isTurnRunning()) {
			if (!this.editor.getText()) this.editor.restoreDraft(draft.editor, draft.localImages);
			this.addSystemNotice("Wait for the current turn before switching to Plan mode.");
			return;
		}
		if (!input) {
			return;
		}
		if (input === "/") {
			this.editor.setText("");
			this.showCommandPalette();
			return;
		}
		if (!planTask && isSlashCommandSubmission(input, this.commandNames())) {
			this.editor.addToHistory(input);
			this.editor.setText("");
			try {
				await this.submitCommand(input);
			} catch (error) {
				this.restoreSubmittedDraft(sessionId, draft);
				throw error;
			}
			return;
		}
		if (!this.validateDraftSkills(planTask ?? input)) {
			if (!this.editor.getText()) this.editor.restoreDraft(draft.editor, draft.localImages);
			return;
		}
		const submitted = this.extractLocalImageAttachments(planTask ?? input);
		this.editor.addToHistory(input, submitted.localImages);
		this.editor.setText("");
		this.editor.clearUndoHistory();
		const startsNewTurn = !this.isTurnRunning() && !this.userTurnPendingStart;
		if (startsNewTurn) {
			this.lastSubmittedInput = {
				text: input,
				...(submitted.localImages.length ? { localImages: submitted.localImages } : {}),
				...(submitted.skillReferences.length ? { skillReferences: submitted.skillReferences } : {}),
			};
			this.lastSubmittedInputEligible = true;
			this.lastSubmittedActivitySignature = this.visibleTurnActivitySignature(this.state);
			this.userTurnPendingStart = true;
		}
		this.lastCtrlCAtMs = null;
		try {
			await this.dispatchAction({
				type: "submit",
				...(planTask ? { collaborationMode: "plan" } : {}),
				text: submitted.text,
				localImages: submitted.localImages,
				...(submitted.skillReferences.length ? { skillReferences: submitted.skillReferences } : {}),
			});
		} catch (error) {
			if (startsNewTurn) {
				if (sessionId === this.state.sessionId) this.userTurnPendingStart = false;
				else if (sessionId) {
					const snapshot = this.composerSnapshots.get(sessionId);
					if (snapshot) snapshot.userTurnPendingStart = false;
				}
			}
			this.restoreSubmittedDraft(sessionId, draft);
			if (sessionId !== this.state.sessionId) throw error;
			const authRecovery = authRecoveryFromError(error);
			if (authRecovery) {
				this.editor.removeLastFromHistory?.(input);
				this.setState({
					...this.state,
					authReadiness: {
						ready: false,
						providerId: authRecovery.providerId,
						authRef: authRecovery.authRef,
						source: "missing",
					},
				});
				this.showLoginFlow(authRecovery.providerId, authRecovery.authRef);
				return;
			}
			throw error;
		}
	}

	private validateDraftSkills(input: string): boolean {
		try {
			parseSkillReferences(skillReferencesInText(this.skillReferences, input));
			return true;
		} catch {
			this.addSystemNotice(`Select at most ${MAX_SKILL_REFERENCES} skills with one source per name. Reopen /skills to resolve conflicting selections.`);
			return false;
		}
	}

	private extractLocalImageAttachments(input: string): { text: string; localImages: MycliShellLocalImageAttachment[]; skillReferences: readonly SkillReference[] } {
		const pendingImages = this.pendingLocalImages.filter((image) => input.includes(image.placeholder));
		const localImages: MycliShellLocalImageAttachment[] = [...pendingImages];
		const text = input.replace(/(^|\s)@([^\s]+)(?=\s|$)/g, (match, prefix: string, path: string) => {
			if (!isImageFilePath(path)) {
				return match;
			}
			const placeholder = nextImagePlaceholder(input, localImages);
			localImages.push({ path, placeholder });
			return `${prefix}${placeholder}`;
		});
		this.pendingLocalImages = [];
		const skillReferences = skillReferencesInText(this.skillReferences, text);
		this.skillReferences = [];
		return { text: text.trim(), localImages, skillReferences };
	}

	private registerDroppedImageFile(path: string): string {
		const placeholder = nextImagePlaceholder(this.editor.getText(), this.pendingLocalImages);
		this.pendingLocalImages.push({ path, placeholder });
		return placeholder;
	}

	private retainPendingImagesInText(text: string): void {
		if (this.pendingLocalImages.length === 0) {
			return;
		}
		const retained = this.pendingLocalImages.filter((image) => text.includes(image.placeholder));
		const unboundLabels = new Set(text.match(/\[image #\d+\]/gu));
		for (const image of retained) unboundLabels.delete(image.placeholder);
		const replacements = new Map<string, string>();
		let number = 1;
		this.pendingLocalImages = retained.map((image) => {
			while (unboundLabels.has(`[image #${number}]`)) number += 1;
			const placeholder = `[image #${number++}]`;
			if (placeholder !== image.placeholder) replacements.set(image.placeholder, placeholder);
			return { ...image, placeholder };
		});
		this.editor.replaceImagePlaceholders(replacements);
	}

	private promotePlainImagePathInput(text: string): boolean {
		const path = text.trim();
		if (!path || text.includes("[image #")) {
			return false;
		}
		if (path !== text || !path.startsWith("/") || !isImageFilePath(path)) {
			return false;
		}
		const placeholder = this.registerDroppedImageFile(path);
		this.editor.setText(placeholder);
		return true;
	}

	private async submitFollowUp(draft: ComposerDraft): Promise<void> {
		const sessionId = this.state.sessionId;
		const input = this.editor.getExpandedText().trim();
		if (!input) {
			return;
		}
		if (!this.validateDraftSkills(input)) return;
		const submitted = this.extractLocalImageAttachments(input);
		this.editor.addToHistory(input, submitted.localImages);
		this.editor.setText("");
		this.editor.clearUndoHistory();
		try {
			await this.dispatchAction({
				type: "follow_up",
				text: submitted.text,
				localImages: submitted.localImages,
				...(submitted.skillReferences.length ? { skillReferences: submitted.skillReferences } : {}),
			});
		} catch (error) {
			this.restoreSubmittedDraft(sessionId, draft);
			throw error;
		}
	}

	private async restoreQueuedInput(): Promise<void> {
		const result = await this.dispatchAction({ type: "dequeue_queued_input" });
		const queued = isMycliUiQueuedInput(result) ? result : null;
		if (!queued) {
			this.addSystemNotice("No queued message to restore.");
			return;
		}
		this.restoreQueuedInputToEditor(queued);
	}

	private async handleInterrupt(): Promise<void> {
		if (this.selectorActive) {
			if (this.clarificationSurfaceRequestId !== null) {
				await this.requestTurnInterrupt();
				return;
			}
			if (this.approvalSurfaceDecisionId !== null) {
				return;
			}
			this.restoreEditor();
			return;
		}
		if (this.isTurnRunning()) {
			await this.requestTurnInterrupt();
			return;
		}
		if (this.editor.getText().length > 0) {
			return;
		}
		this.restoreEditor();
	}

	private async requestTurnInterrupt(): Promise<void> {
		if (this.interruptRequestPending) return;
		this.interruptRequestPending = true;
		try {
			await this.dispatchAction({
				type: "interrupt",
				rollbackUserInput: this.lastSubmittedInputEligible,
			});
		} finally {
			this.interruptRequestPending = false;
		}
	}

	private async handleCtrlC(): Promise<void> {
		if (!this.isTurnRunning() && this.state.footer.goal?.status === "active") {
			await this.dispatchAction({ type: "command", command: "/goal pause" });
			return;
		}
		if (this.isTurnRunning()) {
			const now = this.now();
			const interrupting = this.state.footer.liveStateKind?.trim().toLowerCase() === "interrupting"
				|| this.state.footer.liveState?.trim().toLowerCase() === "interrupting";
			if (interrupting && this.lastCtrlCAtMs !== null && now - this.lastCtrlCAtMs <= 2000) {
				await this.dispatchAction({ type: "exit", reason: "interrupt" });
				return;
			}
			this.lastCtrlCAtMs = now;
			await this.handleInterrupt();
			return;
		}
		if (this.editor.getText().length > 0) {
			this.editor.setText("");
			this.lastCtrlCAtMs = null;
			return;
		}
		const now = this.now();
		if (this.lastCtrlCAtMs !== null && now - this.lastCtrlCAtMs <= 2000) {
			const interrupted = this.state.footer.liveStateKind?.trim().toLowerCase() === "interrupted"
				|| this.state.footer.liveState?.trim().toLowerCase() === "interrupted";
			if (interrupted && (this.options.actions || this.options.onInterruptExit)) {
				await this.dispatchAction({ type: "exit", reason: "interrupt" });
			} else {
				await this.shutdown();
			}
			return;
		}
		this.lastCtrlCAtMs = now;
		this.exitHintVisible = true;
		if (this.exitHintTimer) clearTimeout(this.exitHintTimer);
		this.exitHintTimer = setTimeout(() => this.clearExitHint(), 2000);
		this.exitHintTimer.unref();
		this.rebuildFooter();
		this.rebuildStatus();
		this.ui.requestRender();
	}

	private clearExitHint(): void {
		if (!this.exitHintVisible) return;
		if (this.exitHintTimer) clearTimeout(this.exitHintTimer);
		this.exitHintTimer = null;
		this.exitHintVisible = false;
		this.lastCtrlCAtMs = null;
		this.rebuildFooter();
		this.rebuildStatus();
		this.ui.requestRender();
	}

	private restoreQueuedInputToEditor(input: MycliShellQueuedInput | string): void {
		this.prependQueuedInputs([input]);
	}

	private restoreSubmittedDraft(sessionId: string | undefined, draft: ComposerDraft): void {
		const snapshot = sessionId ? this.composerSnapshots.get(sessionId) : undefined;
		const active = sessionId === this.state.sessionId;
		if (!active && !snapshot) return;
		const current = active ? this.composerDraft() : {
			editor: snapshot!.draft, localImages: snapshot!.pendingLocalImages, skillReferences: snapshot!.skillReferences,
		};
		const restored = current.editor.text ? prependDraftInputs(current, [{
			text: expandEditorDraft(draft.editor), localImages: [...draft.localImages], skillReferences: draft.skillReferences,
		}]) : draft;
		if (active) {
			this.skillReferences = restored.skillReferences;
			this.editor.restoreDraft(restored.editor, restored.localImages);
		} else if (snapshot) {
			snapshot.draft = restored.editor;
			snapshot.pendingLocalImages = [...restored.localImages];
			snapshot.skillReferences = restored.skillReferences;
		}
	}

	private captureComposerSession(sessionId: string | undefined): void {
		if (!sessionId) return;
		const draft = this.editor.getDraft();
		const pendingLocalImages = this.pendingLocalImages
			.filter((image) => draft.text.includes(image.placeholder))
			.map((image) => ({ ...image }));
		this.composerSnapshots.set(sessionId, {
			draft,
			pendingLocalImages,
			skillReferences: skillReferencesInText(this.skillReferences, this.editor.getExpandedText()),
			lastSubmittedInput: cloneQueuedInput(this.lastSubmittedInput),
			lastSubmittedInputEligible: this.lastSubmittedInputEligible,
			lastSubmittedActivitySignature: this.lastSubmittedActivitySignature,
			userTurnPendingStart: this.userTurnPendingStart,
		});
	}

	private restoreComposerSession(sessionId: string | undefined): void {
		const snapshot = sessionId ? this.composerSnapshots.get(sessionId) : undefined;
		this.skillReferences = snapshot?.skillReferences ?? [];
		this.lastSubmittedInput = cloneQueuedInput(snapshot?.lastSubmittedInput ?? null);
		this.lastSubmittedInputEligible = snapshot?.lastSubmittedInputEligible ?? false;
		this.lastSubmittedActivitySignature = snapshot?.lastSubmittedActivitySignature ?? "";
		this.userTurnPendingStart = snapshot?.userTurnPendingStart ?? false;
		this.lastCtrlCAtMs = null;
		this.editor.restoreDraft(
			snapshot?.draft ?? { text: "", pastes: [], cursor: { line: 0, col: 0 } },
			snapshot?.pendingLocalImages ?? [],
		);
	}

	private composerDraft(editor: EditorDraft = this.editor.getDraft()): ComposerDraft {
		return {
			editor,
			localImages: this.pendingLocalImages.filter((image) => editor.text.includes(image.placeholder)).map((image) => ({ ...image })),
			skillReferences: this.skillReferences,
		};
	}

	private prependQueuedInputs(inputs: Array<MycliShellQueuedInput | string>): void {
		const draft = prependDraftInputs(this.composerDraft(), inputs);
		this.skillReferences = draft.skillReferences;
		this.editor.setText(draft.editor.text, draft.localImages);
	}

	private isTurnRunning(): boolean {
		if (this.userTurnPendingStart) {
			return true;
		}
		if (this.isTurnActivityRunning(this.state)) {
			return true;
		}
		const liveStateKind = this.state.footer.liveStateKind?.trim().toLowerCase() ?? "";
		if (["approval", "clarification"].includes(liveStateKind)) {
			return true;
		}
		const liveState = this.state.footer.liveState?.trim().toLowerCase() ?? "";
		return ["waiting approval", "waiting clarification"].includes(liveState);
	}

	private hasQueuedInput(): boolean {
		const pending = this.state.pendingInput;
		return this.state.footer.hasPendingInput === true
			|| Boolean(
				pending
				&& (pending.pendingSteers.length > 0
					|| pending.rejectedSteers.length > 0
					|| pending.followUps.length > 0),
			);
	}

	private commands(): MycliShellCommandSpec[] {
		return this.commandCatalog;
	}

	private commandNames(): string[] {
		return this.routingNames;
	}

	private refreshAutocompleteProvider(): void {
		const slashCommands: SlashCommand[] = this.commands()
			.filter((command) => command.searchOnly !== true && command.available !== false)
			.map((command) => ({
			name: command.name.replace(/^\//, ""),
			description: command.description,
			...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
		}));
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(slashCommands, this.autocompleteBasePath(), null, {
				descriptionSeparator: () => uiGlyphs().descriptionSeparator,
			}),
		);
	}

	private autocompleteBasePath(): string {
		const cwd = this.state.footer.cwd?.trim();
		if (!cwd || cwd.startsWith("~")) {
			return process.cwd();
		}
		return cwd;
	}

	private async submitCommand(command: string): Promise<void> {
		await this.dispatchAction({ type: "command", command });
	}

	private cycleCollaborationMode(): void {
		const nextMode = this.state.footer.collaborationMode === "plan" ? "default" : "plan";
		if (!this.options.actions && !this.options.onCommandSubmit) return;
		this.runAsyncAction(
			async () => {
				await this.dispatchAction({ type: "command", command: `/mode ${nextMode}` });
			},
			"Mode switch failed",
		);
	}

	private toggleToolDetails(): void {
		if (this.toolDetailMode === "expanded") {
			this.toolDetailMode = "collapsed";
		} else if (this.toolDetailMode === "collapsed") {
			this.toolDetailMode = "expanded";
		} else {
			const blocks = this.state.transcript?.length
				? this.state.transcript
				: this.legacyTranscriptBlocks();
			const hasCollapsed = blocks.some((block) =>
				block.kind === "tool"
					? block.tool.expanded !== true
					: block.kind === "provider_attempt" ? !block.providerAttempt.expanded
						: block.kind === "bash" && block.bash.expanded !== true,
			);
			this.toolDetailMode = hasCollapsed ? "expanded" : "collapsed";
		}
		this.setState(this.state);
		this.queueNativeTranscriptHistory(true);
	}

	private applyToolDetailMode(state: MycliShellState, transcriptUpdate?: TranscriptUpdateKind): MycliShellState {
		return this.toolDetailProjector.project(state, this.toolDetailMode, transcriptUpdate);
	}

	clearTerminalView(): void {
		this.ui.insertHistoryBeforeNextFrame([], { clearViewport: true, replaceScrollback: true });
		this.queueNativeTranscriptHistory(true);
		this.ui.requestRender();
	}

	private async setViewMode(rawMode: string): Promise<void> {
		const mode = rawMode === "verbose" || rawMode === "focus" || rawMode === "default" ? rawMode : null;
		if (!mode) {
			this.addSystemNotice("Usage: /view default | /view verbose | /view focus");
			return;
		}
		if (this.options.actions) {
			await this.dispatchAction({ type: "view.set", mode });
			return;
		}
		const next = this.ensureToolsVisible({
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

	private ensureToolsVisible(state: MycliShellState): MycliShellState {
		const tools = state.tools.map((tool) => ({ ...tool, hidden: false }));
		const toolById = new Map(tools.map((tool) => [tool.id, tool]));
		return {
			...state,
			tools,
			transcript: state.transcript?.map((block) => {
				if (block.kind !== "tool") return block;
				return { ...block, tool: toolById.get(block.tool.id) ?? { ...block.tool, hidden: false } };
			}),
		};
	}

	private copyLastAssistantMessage(): void {
		const message = [...this.state.messages].reverse().find((candidate) => candidate.role === "assistant" && candidate.text.trim());
		if (!message) {
			this.addSystemNotice("No assistant message to copy yet.");
			return;
		}
		const copied = copyText(message.text);
		this.addSystemNotice(copied ? "Copied last assistant message." : "Clipboard unavailable. Last assistant message is still visible above.");
	}

	private addSystemNotice(text: string, role: "system" | "warning" | "error" = "system"): void {
		const id = `notice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const message: MycliShellMessage = { id, role, text };
		const transcript = this.state.transcript ?? this.legacyTranscriptBlocks();
		this.setState({
			...this.state,
			messages: [...this.state.messages, message],
			transcript: [...transcript, { id, kind: "message", message }],
			pendingNotice: undefined,
		});
	}

	private runAsyncAction(action: () => Promise<void>, fallback: string): void {
		void action().catch((error: unknown) => {
			const detail = safeErrorMessage(error, fallback);
			this.addSystemNotice(detail === fallback ? fallback : `${fallback}: ${detail}`, "error");
		});
	}

	private patchFooter(footerPatch: Partial<MycliShellState["footer"]>): void {
		this.setState({ ...this.state, footer: { ...this.state.footer, ...footerPatch } });
	}

	private openSettingsAction(
		item: MycliShellSettingsItem,
		selector: SettingsSelectorComponent,
	): void {
		const action = item.action ?? (item.command ? "run_command" : undefined);
		switch (action) {
			case "open_model_selector":
				this.showModelSelector();
				return;
			case "open_login":
				this.showLoginFlow();
				return;
			case "open_permissions":
				this.showPermissionSelector();
				return;
			case "open_trust":
				this.showTrustGate();
				return;
			case "open_session_selector":
				this.showSessionSelector();
				return;
			case "open_resources":
				this.runAsyncAction(() => this.showResourceSelector(), "Unable to load resources");
				return;
			case "reset_keymap":
				void this.resetSettingsKeymap(selector);
				return;
			case "run_command": {
				const command = item.actionArgs ?? item.command;
				if (command) this.runAsyncAction(() => this.submitCommand(command), "Command failed");
				return;
			}
		}
	}

	private async resetSettingsKeymap(selector: SettingsSelectorComponent): Promise<void> {
		const previousState = this.state;
		const sessionRevision = this.sessionRevision;
		this.patchFooter({ liveState: "Resetting keymap" });
		try {
			const snapshot = await this.options.onSettingsKeymapReset?.();
			if (!snapshot) throw new Error("Keymap reset is unavailable in this runtime.");
			const nextState = {
				...this.state,
				settings: snapshot.settings,
				settingsCatalog: snapshot.catalog ?? this.state.settingsCatalog,
				keymap: snapshot.keymap ?? this.state.keymap,
				terminalCapabilities: snapshot.terminalCapabilities ?? this.state.terminalCapabilities,
			};
			this.setState({
				...nextState,
				footer: { ...nextState.footer, liveState: "Keymap reset" },
			});
			if (snapshot.catalog) selector.replaceCatalog(snapshot.catalog);
		} catch (error) {
			if (this.sessionRevision !== sessionRevision) return;
			if (this.state.footer.liveState === "Resetting keymap") {
				this.patchFooter({ liveState: previousState.footer.liveState });
			}
			selector.setError(safeErrorMessage(error, "Failed to reset keymap."));
		}
	}

	private async applySettingsChange(
		item: MycliShellSettingsItem,
		value: string,
		scope: SettingsChangeScope,
		selector: SettingsSelectorComponent,
	): Promise<void> {
		const previousState = this.state;
		const sessionRevision = this.sessionRevision;
		const settings = visualSettingsWithChoice(this.state.settings, item, value);
		if (!settings) {
			selector.setError("Gateway returned an unsupported visual setting.");
			return;
		}
		const optimisticCatalog = settingsCatalogWithChoice(this.state.settingsCatalog, item, value, scope);
		const optimisticState = this.ensureToolsVisible({
			...this.state,
			settings,
			settingsCatalog: optimisticCatalog,
		});
		this.setState({
			...optimisticState,
			footer: {
				...optimisticState.footer,
				liveState: scope === "session" ? "Session setting" : "Saving settings",
			},
		});
		try {
			if (scope === "session") {
				if (item.clientKey === "viewMode" && settings.viewMode) {
					await this.dispatchAction({ type: "view.set", mode: settings.viewMode });
				}
				selector.commit(value, scope, optimisticCatalog);
				return;
			}
			const persistedValue = visualSettingValue(settings, item);
			if (persistedValue === null) throw new Error("The selected setting value is unavailable.");
			const result = await this.options.onSettingsChange?.({
				settingId: item.configKey ?? item.id,
				value: persistedValue,
			});
			if (!result) throw new Error("Persistent settings are unavailable in this runtime.");
			const snapshot = settingsSnapshot(result);
			const savedState = this.ensureToolsVisible({
				...this.state,
				settings: snapshot.settings,
				settingsCatalog: snapshot.catalog ?? optimisticCatalog,
				keymap: snapshot.keymap ?? this.state.keymap,
				terminalCapabilities: snapshot.terminalCapabilities ?? this.state.terminalCapabilities,
			});
			this.setState({
				...savedState,
				footer: { ...savedState.footer, liveState: "Settings saved" },
			});
			selector.commit(value, scope, snapshot.catalog ?? optimisticCatalog);
		} catch (error) {
			if (this.sessionRevision !== sessionRevision) return;
			const settings = { ...this.state.settings };
			const shouldRollback = item.clientKey !== undefined
				&& settings[item.clientKey] === optimisticState.settings?.[item.clientKey];
			if (item.clientKey && shouldRollback) {
				const previousValue = previousState.settings?.[item.clientKey];
				if (previousValue === undefined) delete settings[item.clientKey];
				else Object.assign(settings, { [item.clientKey]: previousValue });
			}
			const previousItem = previousState.settingsCatalog?.items.find((candidate) => candidate.id === item.id);
			this.setState({
				...this.state,
				settings,
				settingsCatalog: this.state.settingsCatalog && previousItem && shouldRollback ? {
					...this.state.settingsCatalog,
					items: this.state.settingsCatalog.items.map((candidate) => candidate.id === item.id ? previousItem : candidate),
				} : this.state.settingsCatalog,
				footer: this.state.footer.liveState === "Saving settings"
					? { ...this.state.footer, liveState: previousState.footer.liveState }
					: this.state.footer,
			});
			selector.setError(safeErrorMessage(error, "Failed to save settings."));
		}
	}

	private authProviders(): MycliShellAuthProvider[] {
		if (this.state.authProviders?.length || this.state.providerRoutes?.length) {
			const providers = new Map((this.state.authProviders ?? []).map((provider) => [provider.id, provider]));
			for (const route of this.state.providerRoutes ?? []) {
				if (!route.configured || route.activation !== "active") continue;
				const previous = providers.get(route.id);
				const authRef = route.authRef ?? route.id;
				providers.set(route.id, {
					...previous,
					id: route.id,
					name: route.name,
					configured: route.ready,
					authRef,
					credentialSource: route.credentialSource ?? (!route.ready ? "missing"
						: (previous?.authRef ?? previous?.id) === authRef ? previous?.credentialSource : undefined),
				});
			}
			return [...providers.values()];
		}
		return defaultAuthProviders();
	}

	private startupAuthenticationRequired(): boolean {
		return this.state.authReadiness?.ready === false;
	}

	private async submitApiKeyLogin(
		providerId: string,
		authRef: string,
		apiKey: string,
		selector: LoginFlowComponent,
		done: () => void,
		onSuccess?: (providerId: string) => void,
		announce = true,
	): Promise<void> {
		const sessionRevision = this.sessionRevision;
		const generation = selector.getSubmissionGeneration();
		const ownsInteraction = (): boolean => this.sessionRevision === sessionRevision
			&& this.selectorStack.at(-1)?.component === selector
			&& selector.getSubmissionGeneration() === generation;
		try {
			const result = await this.options.onApiKeyLogin?.(providerId, apiKey, authRef);
			if (!ownsInteraction()) return;
			const message = result && "message" in result && result.message
				? result.message
				: `Saved API key for ${this.authProviderName(providerId)}.`;
			if (announce) this.addSystemNotice(message);
			this.setState({
				...this.state,
				...(result?.authProviders ? { authProviders: result.authProviders, providerRoutes: [] } : {}),
				...(result?.authReadiness ? { authReadiness: result.authReadiness } : {}),
			});
			done();
			if (onSuccess) {
				onSuccess(providerId);
				return;
			}
			this.mountMain();
			if (this.options.onProviderLoad && this.options.onModelLoad) {
				this.openModelSelector({ preferredProviderId: providerId, lockPreferredProvider: true });
			} else if (this.modelsForProvider(providerId).length > 0) {
				this.showModelSelector(providerId);
			}
		} catch (error) {
			if (ownsInteraction()) selector.setError(safeErrorMessage(error, "Failed to save API key."));
		}
	}

	private authProviderName(providerId: string): string {
		return this.authProviders().find((provider) => provider.id === providerId)?.name ?? providerId;
	}

	private modelsForProvider(providerId: string): MycliShellModel[] {
		if (this.state.modelsProvider && this.state.modelsProvider !== providerId) return [];
		return (this.state.models ?? []).filter((model) => model.provider === providerId);
	}

	private async selectModel(model: MycliShellModel, scope: ModelSelectionScope): Promise<void> {
		const sessionRevision = this.sessionRevision;
		const selected = await this.options.onModelSelect?.(model, scope);
		if (sessionRevision !== this.sessionRevision) return;
		const applied = selected ?? model;
		this.setState({
			...this.state,
			currentModel: applied,
			footer: {
				...this.state.footer,
				provider: applied.provider,
				model: applied.model,
				reasoningLevel: applied.thinkingLevel ?? this.state.footer.reasoningLevel,
			},
		});
		this.addSystemNotice(modelSelectionNotice(applied.provider, applied.model, applied.thinkingLevel, scope));
	}

	private async submitModelSelection(
		model: MycliShellModel,
		scope: ModelSelectionScope,
		selector: ModelSelectorComponent,
		done: () => void,
		onSuccess?: () => void,
	): Promise<void> {
		try {
			await this.selectModel(model, scope);
			done();
			onSuccess?.();
		} catch (error) {
			selector.setError(safeErrorMessage(error, "Model selection failed."));
		}
	}

	private async submitPermissionSelection(
		profile: MycliShellPermissionProfile,
		selector: PermissionSelectorComponent,
		done: () => void,
		onSuccess?: () => void,
		announce = true,
	): Promise<void> {
		try {
			const selected = await this.options.onPermissionSelect?.(profile);
			const permissions = selected ?? permissionStateWithActive(
				this.state.permissions ?? defaultPermissionState(),
				profile.id,
			);
			this.setState({ ...this.state, permissions });
			done();
			onSuccess?.();
			if (announce) this.addSystemNotice(`Permissions updated to ${profile.label}`);
		} catch (error) {
			selector.setError(safeErrorMessage(error, "Permission update failed."));
		}
	}

	private async clearPermissionAllowances(
		selector: PermissionSelectorComponent,
		done: () => void,
	): Promise<void> {
		try {
			const selected = await this.options.onPermissionClearAllowances?.();
			const permissions = selected ?? {
				...(this.state.permissions ?? defaultPermissionState()),
				commandAllowanceCount: 0,
			};
			this.setState({ ...this.state, permissions });
			done();
			this.addSystemNotice("Session command allowances cleared");
		} catch (error) {
			selector.setError(safeErrorMessage(error, "Unable to clear permission allowances."));
		}
	}

	private async selectSession(
		sessionId: string,
		repair?: {
			readonly action: MycliShellResumeRepairAction;
			readonly metadataRevision: number;
		},
	): Promise<MycliShellResumeRepairPreview | null> {
		const result = await this.options.onSessionSelect?.(sessionId, repair);
		if (result && typeof result === "object") return result;
		const selectedSessionId = typeof result === "string" ? result : sessionId;
		this.setState({
			...this.state,
			footer: {
				...this.state.footer,
				sessionName: selectedSessionId,
			},
		});
		return null;
	}

	private async inspectResource(resource: MycliShellResource): Promise<void> {
		const command = resource.command ?? resourceInspectCommand(resource.type);
		if (!command) {
			this.addSystemNotice(`No runtime inspect command for ${resource.type} ${resource.name}.`);
			return;
		}
		await this.dispatchAction({ type: "command", command });
	}

	private async dispatchAction(action: MycliUiAction): Promise<unknown> {
		if (this.options.actions) return this.options.actions.dispatch(action);
		switch (action.type) {
			case "submit":
				return this.options.onSubmit?.(action.text, { localImages: action.localImages ?? [], skillReferences: action.skillReferences, collaborationMode: action.collaborationMode, review: action.review });
			case "follow_up":
				return (this.options.onFollowUp ?? this.options.onSubmit)?.(
					action.text,
					{ localImages: action.localImages ?? [], skillReferences: action.skillReferences, collaborationMode: action.collaborationMode, review: action.review },
				);
			case "command":
				return this.options.onCommandSubmit
					? this.options.onCommandSubmit(action.command)
					: this.options.onSubmit?.(action.command);
			case "view.set":
				return undefined;
			case "interrupt":
				return this.options.onInterrupt?.({ rollbackUserInput: action.rollbackUserInput });
			case "dequeue_queued_input":
				return this.options.onDequeueQueuedInput?.();
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
					action.clarification,
				);
			case "exit":
				return action.reason === "interrupt"
					? (this.options.onInterruptExit ?? this.options.onExit)?.()
					: this.options.onExit?.();
		}
	}
}

function cloneQueuedInput(input: MycliShellQueuedInput | null): MycliShellQueuedInput | null {
	if (!input) return null;
	return {
		text: input.text,
		...(input.skillReferences?.length ? { skillReferences: input.skillReferences.map((skill) => ({ ...skill })) } : {}),
		...(input.localImages
			? { localImages: input.localImages.map((image) => ({ ...image })) }
			: {}),
	};
}

function resumeBlockedMessage(preview: MycliShellResumeRepairPreview): string {
	return preview.issues.find((issue) => issue.blocking)?.message
		?? "This session cannot be resumed automatically.";
}

function trustDecision(value: string | undefined): ProjectTrustDecision {
	if (value === "trusted") return true;
	if (value === "untrusted") return false;
	return null;
}

function transcriptBlocksWerePrepended(
	previous: readonly MycliShellTranscriptBlock[],
	next: readonly MycliShellTranscriptBlock[],
): boolean {
	if (previous.length === 0 || next.length <= previous.length) return false;
	const offset = next.length - previous.length;
	return previous.every((block, index) => next[offset + index]?.id === block.id);
}

function resourceInspectCommand(type: MycliShellResource["type"]): string | null {
	switch (type) {
		case "hook":
			return "/hooks";
		case "plugin":
			return "/plugins";
		case "mcp":
			return "/mcp";
		case "skill":
			return "/skills";
		case "prompt":
			return "/help";
		case "theme":
			return "/settings";
	}
}
