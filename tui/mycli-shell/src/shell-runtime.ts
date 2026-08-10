import { copyText } from "./adapters/clipboard.ts";
import { isSlashCommandSubmission } from "./adapters/slash-commands.ts";
import { SelectList, type SelectItem } from "./tui-core/components/select-list.ts";
import { Spacer } from "./tui-core/components/spacer.ts";
import { Text } from "./tui-core/components/text.ts";
import { ProcessTerminal, type Terminal } from "./tui-core/terminal.ts";
import { Container, TUI, type Component } from "./tui-core/tui.ts";
import { matchesKey } from "./tui-core/keys.ts";
import { visibleWidth } from "./tui-core/utils.ts";
import { CombinedAutocompleteProvider, type SlashCommand } from "./tui-core/autocomplete.ts";
import { installMycliKeybindings } from "./keybindings.ts";
import type {
	MycliShellAuthProvider,
	MycliShellBash,
	MycliShellCommandResult,
	MycliShellCommandSpec,
	MycliShellMessage,
	MycliShellModel,
	MycliShellPendingApproval,
	MycliShellPendingClarification,
	MycliShellPermissionProfile,
	MycliShellPermissionState,
	MycliShellResource,
	MycliShellSessionTree,
	MycliShellSessionTreeNode,
	MycliShellState,
	MycliShellSubagent,
	MycliShellTool,
	MycliShellTranscriptBlock,
	MycliShellVisualSettings,
} from "./model.ts";
import { ApprovalSelectorComponent } from "./components/approval-selector.ts";
import { ClarificationSelectorComponent } from "./components/clarification-selector.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BackgroundTerminalsComponent } from "./components/background-terminals.ts";
import { CollapsedToolGroupComponent } from "./components/collapsed-tool-group.ts";
import { CommandDiagnosticComponent } from "./components/command-diagnostic.ts";
import { CommandResultComponent } from "./components/command-result.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { FooterComponent } from "./components/footer.ts";
import { FileChangeComponent } from "./components/file-change.ts";
import { rawKeyHint } from "./components/keybinding-hints.ts";
import { LoginFlowComponent } from "./components/login-flow.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { PermissionSelectorComponent } from "./components/permission-selector.ts";
import { PlanUpdateComponent } from "./components/plan-update.ts";
import { PendingInputPreviewComponent } from "./components/pending-input-preview.ts";
import { ProposedPlanComponent } from "./components/proposed-plan.ts";
import { ResourceSelectorComponent } from "./components/resource-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SessionTreeSelectorComponent } from "./components/session-tree-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { BackgroundSubagentDialogComponent, isResolvedSubagent, SubagentTaskPanelComponent } from "./components/subagent-task-panel.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { TrustSelectorComponent, type ProjectTrustDecision } from "./components/trust-selector.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { isLocalImageAttachmentPath } from "./local-image-attachments.ts";
import { getEditorTheme, getSelectListTheme, theme } from "./theme/theme.ts";
import {
	createTranscriptProjection,
	projectTranscriptTail,
	type ProjectedTranscriptBlock,
	type TranscriptProjectionState,
} from "./transcript-projection.ts";
import { resolveTranscriptReplayMaxRows } from "./transcript-replay.ts";
import type { TranscriptUpdateKind } from "./adapters/transcript-update.ts";

export type MycliShellRuntimeOptions = {
	initialState: MycliShellState;
	terminal?: Terminal;
	requireTrust?: boolean;
	trustSavedDecision?: ProjectTrustDecision;
	projectTrusted?: boolean;
	onTrustSelect?: (trusted: boolean) => void | Promise<void>;
	onSubmit?: (text: string, attachments?: MycliShellSubmitAttachments) => void | Promise<void>;
	onFollowUp?: (text: string, attachments?: MycliShellSubmitAttachments) => void | Promise<void>;
	onInterrupt?: (options: { rollbackUserInput: boolean }) => boolean | void | Promise<boolean | void>;
	onInterruptExit?: () => void | Promise<void>;
	onDequeueQueuedInput?: () => MycliShellQueuedInput | string | null | Promise<MycliShellQueuedInput | string | null>;
	onCommandSubmit?: (command: string) => void | Promise<void>;
	onExit?: () => void | Promise<void>;
	onSuspend?: () => boolean;
	onModelSelect?: (model: MycliShellModel) => void | MycliShellModel | Promise<void | MycliShellModel>;
	onPermissionSelect?: (profile: MycliShellPermissionProfile) => void | MycliShellPermissionState | Promise<void | MycliShellPermissionState>;
	onPermissionClearAllowances?: () => void | MycliShellPermissionState | Promise<void | MycliShellPermissionState>;
	onApiKeyLogin?: (providerId: string, apiKey: string) => void | { message?: string } | Promise<void | { message?: string }>;
	onSessionSelect?: (sessionId: string) => void | Promise<void>;
	onSessionTreeLoad?: () => MycliShellSessionTree | Promise<MycliShellSessionTree>;
	onSessionTreeSelect?: (node: MycliShellSessionTreeNode) => void | Promise<void>;
	onSettingsChange?: (settings: MycliShellVisualSettings) => MycliShellVisualSettings | Promise<MycliShellVisualSettings>;
	onResourceLoad?: () => MycliShellResource[] | Promise<MycliShellResource[]>;
	onApprovalRespond?: (
		decisionId: string,
		choice: string,
		approval: MycliShellPendingApproval,
	) => void | Promise<void>;
	onClarificationRespond?: (
		requestId: string,
		response: string,
		clarification: MycliShellPendingClarification,
	) => void | Promise<void>;
	commands?: MycliShellCommandSpec[];
	now?: () => number;
	transcriptReplayMaxRows?: number;
};

export type MycliShellStateUpdateOptions = {
	transcriptUpdate?: TranscriptUpdateKind;
};

export type MycliShellLocalImageAttachment = {
	path: string;
	placeholder: string;
};

export type MycliShellSubmitAttachments = {
	localImages?: MycliShellLocalImageAttachment[];
};

export type MycliShellQueuedInput = {
	text: string;
	localImages?: MycliShellLocalImageAttachment[];
};

type ToolDetailMode = "default" | "expanded" | "collapsed";

type ToolDetailOverrideMode = Exclude<ToolDetailMode, "default">;

type DetailArrayUpdate<T> = {
	values: T[];
	kind: "reuse" | "tail" | "append" | "replace";
	replaced?: T;
	added: T[];
};

type ToolDetailProjectionCache = {
	mode: ToolDetailOverrideMode;
	sourceTools: MycliShellTool[];
	tools: MycliShellTool[];
	toolById: Map<string, MycliShellTool>;
	sourceBash: MycliShellBash[];
	bash: MycliShellBash[];
	bashById: Map<string, MycliShellBash>;
	sourceTranscript?: MycliShellTranscriptBlock[];
	transcript?: MycliShellTranscriptBlock[];
};

type TurnActivityStatus = {
	text: string;
	detail?: string;
};

const NATIVE_RESIZE_REFLOW_DEBOUNCE_MS = 75;

type ChatBlockComponent =
	| { kind: "message"; signature: string; role: MycliShellMessage["role"]; component: Component }
	| { kind: "plan"; signature: string; component: ProposedPlanComponent }
	| { kind: "plan_update"; signature: string; component: PlanUpdateComponent }
	| { kind: "tool"; signature: string; component: ToolExecutionComponent }
	| { kind: "file_change"; signature: string; component: FileChangeComponent }
	| { kind: "bash"; signature: string; component: BashExecutionComponent }
	| { kind: "background_terminals"; signature: string; component: BackgroundTerminalsComponent }
	| { kind: "diagnostic"; signature: string; component: CommandDiagnosticComponent }
	| { kind: "command_result"; signature: string; component: CommandResultComponent }
	| { kind: "tool_group"; signature: string; component: CollapsedToolGroupComponent };

class TurnActivityComponent implements Component {
	private readonly frames = ["◐", "◓", "◑", "◒"];
	private frameIndex = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private cachedWidth: number | null = null;
	private cachedFrameIndex: number | null = null;
	private cachedElapsedSeconds: number | null = null;
	private cachedLines: string[] = [];

	constructor(
		private readonly ui: TUI,
		private readonly startedAtMs: number,
		private readonly now: () => number,
		private readonly status: TurnActivityStatus,
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

	invalidate(): void {
		this.cachedWidth = null;
		this.cachedFrameIndex = null;
		this.cachedElapsedSeconds = null;
		this.cachedLines = [];
	}

	render(width: number): string[] {
		const frame = this.frames[this.frameIndex] ?? this.frames[0] ?? "";
		const elapsedSeconds = elapsedSecondsFor(this.now() - this.startedAtMs);
		if (
			width === this.cachedWidth &&
			this.frameIndex === this.cachedFrameIndex &&
			elapsedSeconds === this.cachedElapsedSeconds
		) {
			return this.cachedLines;
		}
		const header = new Text(
			`${theme.fg("accent", frame)} ${theme.fg("muted", `Working (${formatElapsedCompact(elapsedSeconds)} • esc to interrupt)`)}`,
			1,
			0,
		).render(width);
		const detail = this.detailText();
		const lines = detail
			? [...header, ...new Text(theme.fg("dim", `  └ ${detail}`), 1, 0).render(width).slice(0, 2)]
			: header;
		this.cachedWidth = width;
		this.cachedFrameIndex = this.frameIndex;
		this.cachedElapsedSeconds = elapsedSeconds;
		this.cachedLines = lines;
		return lines;
	}

	private detailText(): string | null {
		const generic = new Set(["", "running", "thinking", "streaming", "working"]);
		const statusText = this.status.text.trim();
		const parts = generic.has(statusText.toLowerCase()) ? [] : [statusText];
		const detail = this.status.detail?.trim();
		if (detail && detail !== statusText) {
			parts.push(detail);
		}
		return parts.length > 0 ? parts.join(" · ") : null;
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

class CommandResultOverlayComponent extends Container {
	constructor(result: MycliShellCommandResult, private readonly onClose: () => void) {
		super();
		this.addChild(new CommandResultComponent({ ...result, folded: true }));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Esc close"), 0, 0));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
		}
	}
}

class TurnCompletedComponent implements Component {
	constructor(private readonly durationMs: number) {}

	invalidate(): void {}

	getRenderCacheKey(): number {
		return 0;
	}

	render(width: number): string[] {
		return new Text(theme.fg("muted", `✻ Completed for ${elapsedSecondsFor(this.durationMs)} s`), 1, 0).render(width);
	}
}

type TranscriptContentChange =
	| { kind: "full" }
	| { kind: "section_tail"; section: Container; stablePrefixLength: number };

type TranscriptRenderedChunk = {
	section: Container;
	componentIndex: number;
	start: number;
	sourceStart: number;
	totalLines: number;
};

type TranscriptChunkRender = {
	section: Container;
	componentIndex: number;
	lines: string[];
	totalLines: number;
};

type TranscriptChunkLayout = {
	chunks: TranscriptRenderedChunk[];
	lineOrigin: number;
};

type TranscriptTailRender = {
	lines: string[];
	chunks: TranscriptRenderedChunk[];
	lineOrigin: number;
	chunkOffset: number;
	continuesLineage: boolean;
	cacheable: boolean;
	truncated: boolean;
};

const RETAINED_CHUNK_COMPACTION_MIN_PREFIX = 1_024;

export class TranscriptViewportComponent implements Component {
	private scrollOffset = 0;
	private lastLineCount = 0;
	private lastRenderedLines: string[] = [];
	private lastRenderedWidth: number | undefined;
	private committedPrefixLength = 0;
	private committedPrefixBoundary: string | undefined;
	private committedWidth: number | undefined;
	private committedContentLineage: number | undefined;
	private committedLogicalEnd = 0;
	private pendingScrollbackLineage: number | undefined;
	private pendingScrollbackStart = 0;
	private pendingScrollbackLines: string[] = [];
	private renderCache = new WeakMap<Component, {
		key: unknown;
		width: number;
		maxRows?: number;
		lines: string[];
		totalLines: number;
	}>();
	private retainedContentRevision: unknown;
	private retainedContentWidth: number | undefined;
	private retainedContentLines: string[] = [];
	private retainedContentChunks: TranscriptRenderedChunk[] = [];
	private retainedContentLineOrigin = 0;
	private retainedContentChunkOffset = 0;
	private retainedContentLineage = 0;
	private retainedContentTruncated = false;
	private retainedContentReady = false;
	private pendingContentChange: TranscriptContentChange | undefined;
	private lastRenderedLineOrigin = 0;
	private lastRenderedContentLineage: number | undefined;

	/**
	 * `contentRevision` must change before the owner mutates any transcript-visible content.
	 * Omit it when the owner cannot guarantee that contract; aggregate frame reuse then stays disabled.
	 */
	constructor(
		private readonly content: Container,
		private readonly heightForWidth: (width: number) => number,
		private readonly maxRenderedRows: number | undefined,
		private readonly contentRevision?: () => unknown,
	) {}

	markContentChanged(): void {
		this.pendingContentChange = { kind: "full" };
	}

	/** Record an owner-validated stable component prefix for the last content section. */
	markSectionTailChanged(section: Container, stablePrefixLength: number): void {
		if (!Number.isSafeInteger(stablePrefixLength) || stablePrefixLength < 0) {
			this.markContentChanged();
			return;
		}
		const prefix = stablePrefixLength;
		const pending = this.pendingContentChange;
		if (pending?.kind === "full") return;
		if (pending?.kind === "section_tail" && pending.section !== section) {
			this.pendingContentChange = { kind: "full" };
			return;
		}
		this.pendingContentChange = {
			kind: "section_tail",
			section,
			stablePrefixLength: pending?.kind === "section_tail"
				? Math.min(pending.stablePrefixLength, prefix)
				: prefix,
		};
	}

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
		const lines = this.renderContent(width);
		const height = Math.max(1, this.heightForWidth(width));
		this.lastLineCount = lines.length;
		const target = Math.max(0, Math.min(lineIndex, Math.max(0, lines.length - 1)));
		this.scrollOffset = Math.max(0, lines.length - height - target);
	}

	scrollbackPrefix(width: number): string[] {
		const height = Math.max(1, this.heightForWidth(width));
		const lines = this.renderContent(width);
		this.scrollOffset = 0;
		this.lastLineCount = lines.length;
		const start = this.visibleStart(lines, height);
		this.recordCommittedPrefix(lines, start, width);
		return lines.slice(0, start);
	}

	scrollbackPrefixBefore(section: Container, componentIndex: number, width: number): string[] {
		const sectionIndex = this.content.children.indexOf(section);
		if (sectionIndex < 0) return [];
		// The excluded suffix still owns replay rows and live viewport cells.
		const suffixChunks: string[][] = [];
		const prefixChunks: string[][] = [];
		let renderedRows = 0;
		sections: for (let currentSectionIndex = this.content.children.length - 1; currentSectionIndex >= 0; currentSectionIndex -= 1) {
			const currentSection = this.content.children[currentSectionIndex]!;
			const components = currentSection instanceof Container ? currentSection.children : [currentSection];
			const targetIndex = currentSection === section
				? Math.max(0, Math.min(componentIndex, components.length - 1))
				: currentSectionIndex > sectionIndex
					? 0
					: components.length;
			const end = components.length;
			for (let index = end - 1; index >= 0; index -= 1) {
				const isSuffix = currentSectionIndex > sectionIndex || (currentSection === section && index >= targetIndex);
				const remaining = this.maxRenderedRows === undefined
					? undefined
					: this.maxRenderedRows - renderedRows;
				if (remaining !== undefined && remaining <= 0) break sections;
				const rendered = this.renderComponent(components[index]!, width, remaining);
				(isSuffix ? suffixChunks : prefixChunks).push(rendered.lines);
				renderedRows += rendered.lines.length;
			}
			if (this.maxRenderedRows !== undefined && renderedRows >= this.maxRenderedRows) break;
		}
		prefixChunks.reverse();
		suffixChunks.reverse();
		const prefixLines = prefixChunks.flat();
		const lines = [...prefixLines, ...suffixChunks.flat()];
		const height = Math.max(1, this.heightForWidth(width));
		return prefixLines.slice(0, Math.min(prefixLines.length, this.visibleStart(lines, height)));
	}

	discardPendingScrollbackLines(): void {
		this.clearPendingScrollbackLines();
	}

	takeNewScrollbackLines(width: number, refreshLines = false): string[] {
		if (this.scrollOffset !== 0 || (!refreshLines && this.lastRenderedWidth !== width)) return [];
		const height = Math.max(1, this.heightForWidth(width));
		const previousLines = this.lastRenderedLines;
		const previousStart = this.visibleStart(previousLines, height);
		const lines = refreshLines ? this.renderContent(width) : this.lastRenderedLines;
		this.lastLineCount = lines.length;
		const start = this.visibleStart(lines, height);
		const boundedWindowRolled =
			this.maxRenderedRows !== undefined &&
			previousLines.length >= this.maxRenderedRows &&
			lines.length >= this.maxRenderedRows;
		const logicalDelta = this.takeLogicalScrollbackDelta(lines, start, width);
		if (logicalDelta !== undefined) {
			this.recordCommittedPrefix(lines, start, width);
			return logicalDelta;
		}
		if (refreshLines && boundedWindowRolled && this.committedWidth === width && previousLines.length > 0) {
			const overlap = suffixPrefixOverlapLength(previousLines, lines);
			const droppedRows = previousLines.length - overlap;
			const delta = this.takePendingScrollbackLines();
			if (droppedRows > previousStart) {
				delta.push(...previousLines.slice(previousStart, droppedRows));
			}
			const survivingPreviousStart = Math.max(0, previousStart - droppedRows);
			delta.push(...lines.slice(survivingPreviousStart, start));
			this.recordCommittedPrefix(lines, start, width);
			return delta;
		}
		const pendingDelta = this.takePendingScrollbackLines();
		if (pendingDelta.length > 0) {
			this.recordCommittedPrefix(lines, start, width);
			return pendingDelta;
		}
		const boundaryChanged =
			this.committedPrefixLength > 0 &&
			lines[this.committedPrefixLength - 1] !== this.committedPrefixBoundary;
		if (
			this.committedWidth !== width ||
			start < this.committedPrefixLength ||
			boundaryChanged
		) {
			this.recordCommittedPrefix(lines, start, width);
			return [];
		}
		const delta = lines.slice(this.committedPrefixLength, start);
		this.recordCommittedPrefix(lines, start, width);
		return delta;
	}

	invalidate(): void {
		this.content.invalidate();
		this.renderCache = new WeakMap();
		this.retainedContentReady = false;
		this.retainedContentLines = [];
		this.retainedContentChunks = [];
		this.retainedContentLineOrigin = 0;
		this.retainedContentChunkOffset = 0;
		this.retainedContentLineage += 1;
		this.retainedContentTruncated = false;
		this.retainedContentWidth = undefined;
		this.pendingContentChange = undefined;
		this.lastRenderedContentLineage = undefined;
		this.clearPendingScrollbackLines();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.heightForWidth(width));
		const widthChanged = this.lastRenderedWidth !== undefined && this.lastRenderedWidth !== width;
		const lines = this.renderContent(width);
		if (!widthChanged && lines.length > this.lastLineCount) {
			this.scrollOffset = 0;
		}
		this.lastLineCount = lines.length;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, lines.length - height));

		const start = this.visibleStart(lines, height);
		const visible = lines.slice(start, start + height);
		while (visible.length < height) {
			visible.push("");
		}
		return visible;
	}

	private visibleStart(lines: string[], height: number): number {
		let start = Math.max(0, lines.length - height - this.scrollOffset);
		if (this.scrollOffset === 0) {
			while (start > 0 && lines.slice(start, start + height).every(isVisuallyBlankLine)) {
				start -= 1;
			}
		}
		return start;
	}

	private renderContent(width: number): string[] {
		const revision = this.contentRevision?.();
		const pendingChange = this.pendingContentChange;
		let lines: string[];
		if (
			this.maxRenderedRows !== undefined &&
			this.contentRevision !== undefined &&
			pendingChange === undefined &&
			this.retainedContentReady &&
			this.retainedContentWidth === width &&
			Object.is(this.retainedContentRevision, revision)
		) {
			lines = this.retainedContentLines;
		} else if (this.maxRenderedRows === undefined) {
			lines = this.content.render(width);
			this.retainedContentReady = false;
		} else {
			const incremental =
				pendingChange?.kind === "section_tail" &&
				this.retainedContentReady &&
				this.retainedContentWidth === width
					? this.renderContentTailUpdate(width, this.maxRenderedRows, pendingChange)
					: undefined;
			const rendered = incremental ?? this.renderContentTail(width, this.maxRenderedRows);
			if (incremental === undefined || !rendered.continuesLineage) {
				this.retainedContentLineage += 1;
			}
			lines = rendered.lines;
			this.retainedContentRevision = revision;
			this.retainedContentWidth = width;
			this.retainedContentLines = lines;
			this.retainedContentChunks = rendered.chunks;
			this.retainedContentLineOrigin = rendered.lineOrigin;
			this.retainedContentChunkOffset = rendered.chunkOffset;
			this.retainedContentTruncated = rendered.truncated;
			this.retainedContentReady = this.contentRevision !== undefined && rendered.cacheable;
		}
		this.pendingContentChange = undefined;
		this.lastRenderedLines = lines;
		this.lastRenderedWidth = width;
		this.lastRenderedLineOrigin = this.maxRenderedRows === undefined
			? 0
			: this.retainedContentLineOrigin;
		this.lastRenderedContentLineage = this.maxRenderedRows === undefined
			? undefined
			: this.retainedContentLineage;
		return lines;
	}

	private renderContentTail(width: number, maxRows: number): TranscriptTailRender {
		const chunks: TranscriptChunkRender[] = [];
		let renderedRows = 0;
		let cacheable = true;
		let truncated = false;
		for (let sectionIndex = this.content.children.length - 1; sectionIndex >= 0; sectionIndex -= 1) {
			const section = this.content.children[sectionIndex]!;
			const components = section instanceof Container ? section.children : [section];
			for (let index = components.length - 1; index >= 0; index -= 1) {
				const rendered = this.renderComponent(components[index]!, width, maxRows - renderedRows);
				chunks.push({
					section: section instanceof Container ? section : this.content,
					componentIndex: index,
					lines: rendered.lines,
					totalLines: rendered.totalLines,
				});
				renderedRows += rendered.lines.length;
				cacheable &&= rendered.cacheable;
				truncated ||= rendered.totalLines > rendered.lines.length;
				if (renderedRows >= maxRows) {
					truncated ||= index > 0 || sectionIndex > 0;
					break;
				}
			}
			if (renderedRows >= maxRows) break;
		}
		chunks.reverse();
		const lines = chunks.flatMap((chunk) => chunk.lines);
		const layout = this.layoutRenderedChunks(chunks, 0);
		return {
			lines,
			chunks: layout.chunks,
			lineOrigin: layout.lineOrigin,
			chunkOffset: 0,
			continuesLineage: false,
			cacheable,
			truncated,
		};
	}

	private renderContentTailUpdate(
		width: number,
		maxRows: number,
		change: Extract<TranscriptContentChange, { kind: "section_tail" }>,
	): TranscriptTailRender | undefined {
		if (this.content.children.at(-1) !== change.section) return undefined;
		if (change.stablePrefixLength > change.section.children.length) return undefined;

		let chunkBoundary = this.retainedContentChunks.length;
		while (chunkBoundary > this.retainedContentChunkOffset) {
			const chunk = this.retainedContentChunks[chunkBoundary - 1]!;
			if (chunk.section !== change.section || chunk.componentIndex < change.stablePrefixLength) break;
			chunkBoundary -= 1;
		}
		const firstChangedChunk = this.retainedContentChunks[chunkBoundary];
		const lineBoundary = firstChangedChunk?.section === change.section
			? Math.max(
				0,
				Math.min(
					this.retainedContentLines.length,
					firstChangedChunk.start - this.retainedContentLineOrigin,
				),
			)
			: this.retainedContentLines.length;

		const suffixChunks: TranscriptChunkRender[] = [];
		let renderedRows = 0;
		let cacheable = true;
		let truncated = false;
		for (let index = change.section.children.length - 1; index >= change.stablePrefixLength; index -= 1) {
			const rendered = this.renderComponent(
				change.section.children[index]!,
				width,
				maxRows - renderedRows,
			);
			suffixChunks.push({
				section: change.section,
				componentIndex: index,
				lines: rendered.lines,
				totalLines: rendered.totalLines,
			});
			renderedRows += rendered.lines.length;
			cacheable &&= rendered.cacheable;
			truncated ||= rendered.totalLines > rendered.lines.length;
			if (renderedRows >= maxRows) {
				truncated ||= index > change.stablePrefixLength || change.stablePrefixLength > 0;
				break;
			}
		}
		suffixChunks.reverse();
		const suffixLines = suffixChunks.flatMap((chunk) => chunk.lines);
		const suffixCoversBoundary = suffixChunks[0]?.componentIndex === change.stablePrefixLength;
		const suffixSourceStart =
			firstChangedChunk?.section === change.section &&
			firstChangedChunk.componentIndex === change.stablePrefixLength
				? firstChangedChunk.sourceStart
				: firstChangedChunk === undefined
					? this.retainedContentLineOrigin + lineBoundary
					: undefined;
		if (suffixLines.length >= maxRows) {
			let layout: TranscriptChunkLayout | undefined;
			let continuesLineage = false;
			if (suffixCoversBoundary && suffixSourceStart !== undefined) {
				const candidate = this.layoutRenderedChunks(suffixChunks, suffixSourceStart);
				const retainedEnd = this.retainedContentLineOrigin + this.retainedContentLines.length;
				if (
					candidate.lineOrigin >= this.retainedContentLineOrigin &&
					candidate.lineOrigin <= retainedEnd
				) {
					layout = candidate;
					continuesLineage = true;
					this.retainDisplacedScrollbackLines(width, this.retainedContentLines, candidate.lineOrigin);
				}
			}
			layout ??= this.layoutRenderedChunks(suffixChunks, 0);
			return {
				lines: suffixLines,
				chunks: layout.chunks,
				lineOrigin: layout.lineOrigin,
				chunkOffset: 0,
				continuesLineage,
				cacheable,
				truncated: true,
			};
		}

		const combinedLines = [...this.retainedContentLines.slice(0, lineBoundary), ...suffixLines];
		const nextLineCount = combinedLines.length;
		if (nextLineCount < maxRows && this.retainedContentTruncated) return undefined;

		const trimmedRows = Math.max(0, nextLineCount - maxRows);
		const lines = trimmedRows > 0 ? combinedLines.slice(trimmedRows) : combinedLines;
		const lineOrigin = this.retainedContentLineOrigin + trimmedRows;
		this.retainDisplacedScrollbackLines(width, combinedLines, lineOrigin);
		const suffixLayout = this.layoutRenderedChunks(
			suffixChunks,
			suffixSourceStart ?? this.retainedContentLineOrigin + lineBoundary,
		);
		const chunks = this.retainedContentChunks;
		chunks.splice(chunkBoundary, chunks.length - chunkBoundary, ...suffixLayout.chunks);
		let chunkOffset = this.trimRetainedChunkPrefix(
			chunks,
			this.retainedContentChunkOffset,
			lineOrigin,
			lineOrigin + lines.length,
		);
		if (
			chunkOffset >= RETAINED_CHUNK_COMPACTION_MIN_PREFIX &&
			chunkOffset * 2 >= chunks.length
		) {
			chunks.splice(0, chunkOffset);
			chunkOffset = 0;
		}
		return {
			lines,
			chunks,
			lineOrigin,
			chunkOffset,
			continuesLineage: true,
			cacheable,
			truncated: this.retainedContentTruncated || truncated || trimmedRows > 0,
		};
	}

	private layoutRenderedChunks(
		chunks: TranscriptChunkRender[],
		sourceStart: number,
	): TranscriptChunkLayout {
		let cursor = sourceStart;
		let lineOrigin = sourceStart;
		const metadata = chunks.map((chunk, index): TranscriptRenderedChunk => {
			const start = cursor + Math.max(0, chunk.totalLines - chunk.lines.length);
			if (index === 0) lineOrigin = start;
			const result = {
				section: chunk.section,
				componentIndex: chunk.componentIndex,
				start,
				sourceStart: cursor,
				totalLines: chunk.totalLines,
			};
			cursor += chunk.totalLines;
			return result;
		});
		return { chunks: metadata, lineOrigin };
	}

	private trimRetainedChunkPrefix(
		chunks: TranscriptRenderedChunk[],
		chunkOffset: number,
		lineOrigin: number,
		logicalEnd: number,
	): number {
		let offset = chunkOffset;
		while (offset < chunks.length) {
			const nextStart = chunks[offset + 1]?.start ?? logicalEnd;
			if (nextStart > lineOrigin) break;
			offset += 1;
		}
		return offset;
	}

	private retainDisplacedScrollbackLines(
		width: number,
		combinedLines: string[],
		nextLineOrigin: number,
	): void {
		if (
			this.committedWidth !== width ||
			this.committedContentLineage !== this.retainedContentLineage ||
			nextLineOrigin <= this.retainedContentLineOrigin
		) {
			return;
		}
		const pendingEnd = this.pendingScrollbackLineage === this.retainedContentLineage
			? this.pendingScrollbackStart + this.pendingScrollbackLines.length
			: this.committedLogicalEnd;
		const start = Math.max(this.retainedContentLineOrigin, pendingEnd);
		if (start >= nextLineOrigin) return;
		const displaced = combinedLines.slice(
			start - this.retainedContentLineOrigin,
			nextLineOrigin - this.retainedContentLineOrigin,
		);
		if (displaced.length === 0) return;
		if (this.pendingScrollbackLineage !== this.retainedContentLineage) {
			this.pendingScrollbackLineage = this.retainedContentLineage;
			this.pendingScrollbackStart = start;
			this.pendingScrollbackLines = displaced;
			return;
		}
		this.pendingScrollbackLines.push(...displaced);
	}

	private takeLogicalScrollbackDelta(
		lines: string[],
		start: number,
		width: number,
	): string[] | undefined {
		const lineage = this.lastRenderedContentLineage;
		if (
			lineage === undefined ||
			lineage !== this.committedContentLineage ||
			this.committedWidth !== width
		) {
			return undefined;
		}
		const logicalEnd = this.lastRenderedLineOrigin + start;
		if (logicalEnd < this.committedLogicalEnd) return undefined;

		const hasPending =
			this.pendingScrollbackLines.length > 0 &&
			this.pendingScrollbackLineage === lineage;
		if (hasPending && this.pendingScrollbackStart !== this.committedLogicalEnd) return undefined;
		const pendingEnd = hasPending
			? this.pendingScrollbackStart + this.pendingScrollbackLines.length
			: this.committedLogicalEnd;
		if (pendingEnd < this.lastRenderedLineOrigin || pendingEnd > logicalEnd) return undefined;
		const delta = this.takePendingScrollbackLines(lineage);
		delta.push(...lines.slice(
			pendingEnd - this.lastRenderedLineOrigin,
			logicalEnd - this.lastRenderedLineOrigin,
		));
		return delta;
	}

	private takePendingScrollbackLines(lineage?: number): string[] {
		if (
			this.pendingScrollbackLines.length === 0 ||
			(lineage !== undefined && this.pendingScrollbackLineage !== lineage)
		) {
			return [];
		}
		const lines = this.pendingScrollbackLines;
		this.clearPendingScrollbackLines();
		return lines;
	}

	private clearPendingScrollbackLines(): void {
		this.pendingScrollbackLineage = undefined;
		this.pendingScrollbackStart = 0;
		this.pendingScrollbackLines = [];
	}

	private renderComponent(
		component: Component,
		width: number,
		maxRows?: number,
	): { lines: string[]; totalLines: number; cacheable: boolean } {
		const key = component.getRenderCacheKey?.();
		if (key === undefined) {
			return { ...this.renderComponentLines(component, width, maxRows), cacheable: false };
		}

		const cached = this.renderCache.get(component);
		if (cached && cached.width === width && cached.maxRows === maxRows && Object.is(cached.key, key)) {
			return { lines: cached.lines, totalLines: cached.totalLines, cacheable: true };
		}
		const rendered = this.renderComponentLines(component, width, maxRows);
		this.renderCache.set(component, { key, width, maxRows, ...rendered });
		return { ...rendered, cacheable: true };
	}

	private renderComponentLines(
		component: Component,
		width: number,
		maxRows?: number,
	): { lines: string[]; totalLines: number } {
		if (maxRows !== undefined) {
			if (maxRows <= 0) return { lines: [], totalLines: 0 };
			if (component.renderTail) return component.renderTail(width, maxRows);
			const lines = component.render(width);
			return { lines: lines.slice(-maxRows), totalLines: lines.length };
		}
		const lines = component.render(width);
		return { lines, totalLines: lines.length };
	}

	private recordCommittedPrefix(lines: string[], start: number, width: number): void {
		this.committedPrefixLength = start;
		this.committedPrefixBoundary = start > 0 ? lines[start - 1] : undefined;
		this.committedWidth = width;
		this.committedContentLineage = this.lastRenderedContentLineage;
		this.committedLogicalEnd = this.lastRenderedLineOrigin + start;
		this.clearPendingScrollbackLines();
	}
}

class FrameCachedContainer extends Container {
	private cachedFrameId: number | null = null;
	private cachedWidth: number | null = null;
	private cachedRevision: number | undefined;
	private cachedLines: string[] = [];

	constructor(
		private readonly activeFrameId: () => number | null,
		private readonly cacheAcrossFrames = false,
	) {
		super();
	}

	override render(width: number): string[] {
		const frameId = this.activeFrameId();
		const revision = this.getRenderCacheKey();
		const canReuse =
			revision !== undefined &&
			revision === this.cachedRevision &&
			width === this.cachedWidth &&
			(this.cacheAcrossFrames || (frameId !== null && frameId === this.cachedFrameId));
		if (canReuse) {
			return this.cachedLines;
		}
		const lines = super.render(width);
		if (revision !== undefined && (this.cacheAcrossFrames || frameId !== null)) {
			this.cachedFrameId = frameId;
			this.cachedWidth = width;
			this.cachedRevision = revision;
			this.cachedLines = lines;
		}
		return lines;
	}
}

function isVisuallyBlankLine(line: string): boolean {
	return visibleWidth(line.replace(/\s/g, "")) === 0;
}

function suffixPrefixOverlapLength(previousLines: string[], nextLines: string[]): number {
	if (previousLines.length === 0 || nextLines.length === 0) return 0;
	const prefix = new Array<number>(nextLines.length).fill(0);
	for (let index = 1; index < nextLines.length; index += 1) {
		let matched = prefix[index - 1] ?? 0;
		while (matched > 0 && nextLines[index] !== nextLines[matched]) {
			matched = prefix[matched - 1] ?? 0;
		}
		if (nextLines[index] === nextLines[matched]) matched += 1;
		prefix[index] = matched;
	}

	let matched = 0;
	for (let index = 0; index < previousLines.length; index += 1) {
		const line = previousLines[index]!;
		while (matched > 0 && line !== nextLines[matched]) {
			matched = prefix[matched - 1] ?? 0;
		}
		if (line === nextLines[matched]) matched += 1;
		if (matched === nextLines.length && index < previousLines.length - 1) {
			matched = prefix[matched - 1] ?? 0;
		}
	}
	return matched;
}

function mapDetailArray<T>(source: T[], project: (value: T) => T): T[] {
	let result: T[] | null = null;
	for (let index = 0; index < source.length; index += 1) {
		const current = source[index]!;
		const projected = project(current);
		if (!result && projected !== current) result = source.slice(0, index);
		result?.push(projected);
	}
	return result ?? source;
}

function projectDetailArray<T>(
	source: T[],
	previousSource: T[] | undefined,
	previousValues: T[] | undefined,
	hint: TranscriptUpdateKind | undefined,
	project: (value: T) => T,
): DetailArrayUpdate<T> {
	if (previousSource && previousValues && source === previousSource) {
		return { values: previousValues, kind: "reuse", added: [] };
	}
	if (
		hint === "tail" &&
		previousSource &&
		previousValues &&
		previousSource.length === previousValues.length
	) {
		if (
			source.length === previousSource.length &&
			source.length > 0 &&
			(source.length === 1 || source[source.length - 2] === previousSource[previousSource.length - 2])
		) {
			if (source[source.length - 1] === previousSource[previousSource.length - 1]) {
				return { values: previousValues, kind: "reuse", added: [] };
			}
			const added = project(source[source.length - 1]!);
			return {
				values: previousValues.with(-1, added),
				kind: "tail",
				replaced: previousValues.at(-1),
				added: [added],
			};
		}
		if (
			source.length > previousSource.length &&
			(previousSource.length === 0 || source[previousSource.length - 1] === previousSource.at(-1))
		) {
			const added = mapDetailArray(source.slice(previousSource.length), project);
			return { values: previousValues.concat(added), kind: "append", added };
		}
	}
	const values = mapDetailArray(source, project);
	return { values, kind: "replace", added: values };
}

function detailIndex<T extends { id: string }>(
	update: DetailArrayUpdate<T>,
	previous: Map<string, T> | undefined,
): Map<string, T> {
	if (update.kind === "reuse" && previous) return previous;
	if ((update.kind === "tail" || update.kind === "append") && previous) {
		if (update.replaced && !update.added.some((item) => item.id === update.replaced?.id)) {
			previous.delete(update.replaced.id);
		}
		for (const item of update.added) previous.set(item.id, item);
		return previous;
	}
	return new Map(update.values.map((item) => [item.id, item]));
}

export class MycliShellRuntime {
	readonly ui: TUI;
	readonly headerContainer = new Container();
	readonly chatContainer = new Container();
	readonly transcriptContainer = new Container();
	readonly transcriptViewport: TranscriptViewportComponent;
	readonly pendingMessagesContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId);
	readonly statusContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId);
	readonly editorContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId);
	readonly subagentTaskContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId, true);
	readonly footerContainer = new FrameCachedContainer(() => this.ui.activeRenderFrameId, true);
	readonly editor: CustomEditor;

	private state: MycliShellState;
	private transcriptRenderRevision = 0;
	private started = false;
	private mainMounted = false;
	private chatBlocks = new Map<string, ChatBlockComponent>();
	private projectedChatBlocks: ProjectedTranscriptBlock[] = [];
	private transcriptProjection: TranscriptProjectionState | null = null;
	private turnActivity: TurnActivityComponent | null = null;
	private turnStartedAtMs: number | null = null;
	private completedDurationMs: number | null = null;
	private selectorActive = false;
	private sessionTransitionDepth = 0;
	private approvalSurfaceDecisionId: string | null = null;
	private clarificationSurfaceRequestId: string | null = null;
	private readonly now: () => number;
	private lastCtrlCAtMs: number | null = null;
	private lastSubmittedInput: MycliShellQueuedInput | null = null;
	private lastSubmittedInputEligible = false;
	private lastSubmittedActivitySignature = "";
	private userTurnPendingStart = false;
	private dismissedSubagentIds = new Set<string>();
	private pendingLocalImages: MycliShellLocalImageAttachment[] = [];
	private toolDetailMode: ToolDetailMode = "default";
	private toolDetailProjection: ToolDetailProjectionCache | null = null;
	private nativeResizeTimer: ReturnType<typeof setTimeout> | undefined;
	private nativeTranscriptDeltaHeld = false;

	constructor(private readonly options: MycliShellRuntimeOptions) {
		this.state = options.initialState;
		this.now = options.now ?? Date.now;
		this.ui = new TUI(options.terminal ?? new ProcessTerminal());
		this.ui.onResize = () => this.handleTerminalResize();
		this.ui.onSuspend = options.onSuspend;
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
		const keybindings = installMycliKeybindings();
		this.editor = new CustomEditor(this.ui, getEditorTheme(), keybindings, {
			paddingX: 1,
			autocompleteMaxVisible: 8,
			onDroppedImageFile: (path) => this.registerDroppedImageFile(path),
		});
		this.refreshAutocompleteProvider();
		this.editor.onChange = (text) => {
			if (this.promotePlainImagePathInput(text)) {
				return;
			}
			this.retainPendingImagesInText(text);
		};
		this.editor.onSubmit = (text) => {
			this.runAsyncAction(() => this.handleSubmit(text), "Message submission failed");
		};
		this.editor.onPasteImage = () => {
			this.editor.insertTextAtCursor?.(" @");
		};
		this.editor.shouldHandleAction = (action) => {
			if (action === "app.message.followUp") {
				return this.isTurnRunning();
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
		this.editor.onAction("app.help", () => this.showCommandPalette());
		this.editor.onAction("app.model.select", () => this.showModelSelector());
		this.editor.onAction("app.mode.cycle", () => {
			this.runAsyncAction(() => this.cycleCollaborationMode(), "Mode change failed");
		});
		this.editor.onAction("app.permissions.open", () => {
			this.showPermissionSelector();
		});
		this.editor.onAction("app.message.followUp", () => {
			this.runAsyncAction(() => this.submitFollowUp(), "Follow-up submission failed");
		});
		this.editor.onAction("app.message.dequeue", () => {
			this.runAsyncAction(() => this.restoreQueuedInput(), "Queued message restore failed");
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

	setState(nextState: MycliShellState, options: MycliShellStateUpdateOptions = {}): void {
		const previousState = this.state;
		const effectiveState = this.applyToolDetailMode(nextState, options.transcriptUpdate);
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
		this.state = effectiveState;
		if (this.mainMounted) {
			this.rebuildChangedSections(previousState, effectiveState, options.transcriptUpdate);
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
		for (const input of inputs.reverse()) {
			this.restoreQueuedInputToEditor(input);
		}
	}

	async shutdown(): Promise<void> {
		this.stopTurnActivity();
		if (this.nativeResizeTimer) {
			clearTimeout(this.nativeResizeTimer);
			this.nativeResizeTimer = undefined;
		}
		if (this.started) {
			this.ui.stop();
			this.started = false;
		}
		this.ui.setRenderingPaused(false);
		await this.options.onExit?.();
	}

	refreshTurnStatus(): void {
		this.rebuildStatus();
		this.ui.requestRender();
	}

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (this.ui.hasOverlay() || this.selectorActive) {
			return undefined;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.runAsyncAction(() => this.handleCtrlC(), "Interrupt request failed");
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			this.toggleToolDetails();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && this.isTurnRunning()) {
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
			let selectionPending = false;
			const selector = new TrustSelectorComponent({
				cwd: this.state.footer.cwd,
				savedDecision: this.options.trustSavedDecision ?? null,
				projectTrusted: this.options.projectTrusted ?? false,
				onSelect: (trusted) => {
					if (selectionPending) return;
					selectionPending = true;
					selector.setError();
					void Promise.resolve(this.options.onTrustSelect?.(trusted))
						.then(() => {
							if (trusted) {
								done();
								this.mountMain();
								this.patchFooter({ trust: "trusted" });
								this.ui.setFocus(this.editor);
								return;
							}
							void this.shutdown();
						})
						.catch(() => {
							selectionPending = false;
							selector.setError("Unable to save workspace trust.");
							this.ui.requestRender();
						});
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
					label: command.name,
					description: command.description,
				})),
				Math.min(10, Math.max(4, commands.length)),
				getSelectListTheme(),
				{ minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 28 },
			);
			list.onSelect = (item: SelectItem) => {
				done();
				const command = commands.find((candidate) => candidate.id === item.value);
				if (command) void this.submitCommand(command.name);
			};
			list.onCancel = () => done();
			return { component: list, focus: list };
		});
	}

	showCommandResultOverlay(result: MycliShellCommandResult): void {
		this.showSelector((done) => {
			const overlay = new CommandResultOverlayComponent(result, done);
			return { component: overlay, focus: overlay };
		});
	}

	async handleClientAction(action: string, args: string): Promise<void> {
		const handlers: Record<string, () => void | Promise<void>> = {
			open_command_palette: () => this.showCommandPalette(),
			open_model_selector: () => this.showModelSelector(args || undefined),
			open_permissions: () => this.showPermissionSelector(),
			open_settings: () => this.showSettingsSelector(),
			open_session_selector: () => this.showSessionSelector(),
			start_new_session: () => this.startNewLocalSession(),
			open_resources: () => this.showResourceSelector(),
			open_tasks: () => this.showBackgroundSubagents(),
			toggle_details: () => this.toggleToolDetails(),
			set_view_mode: () => this.setViewMode(args),
			open_hotkeys: () => this.showHotkeys(),
			copy_last_response: () => this.copyLastAssistantMessage(),
			clear_transcript: () => this.clearTranscript(),
			open_login: () => this.showLoginFlow(),
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
		const models = this.state.models ?? [];
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent({
				tui: this.ui,
				currentModel: this.state.currentModel,
				models,
				initialSearchInput,
					onSelect: (model) => {
						void this.submitModelSelection(model, selector, done);
					},
				onCancel: () => done(),
			});
			return { component: selector, focus: selector };
		});
	}

	showPermissionSelector(): void {
		const permissions = this.state.permissions ?? defaultPermissionState();
		this.showSelector((done) => {
			const selector = new PermissionSelectorComponent({
				permissions,
				onSelect: (profile) => {
					void this.submitPermissionSelection(profile, selector, done);
				},
				onClearAllowances: () => {
					void this.clearPermissionAllowances(selector, done);
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
					void this.selectSession(session.id).then(
						() => {
							done();
							this.queueNativeTranscriptHistory(true);
						},
						() => done(),
					);
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
		this.ui.addChild(this.transcriptViewport);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.subagentTaskContainer);
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
		const transcriptMounted = this.ui.children.includes(this.transcriptViewport);
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
		this.rebuildStatus();
		this.rebuildSubagentTasks();
		this.rebuildFooter();
		this.rebuildPending();
		this.syncPendingSurface(null, this.state);
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
			this.isCompletedLiveState(previousState.footer.liveState) !==
			this.isCompletedLiveState(nextState.footer.liveState);
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
		if (this.liveStateSignature(previousState) !== this.liveStateSignature(nextState)) {
			this.rebuildStatus();
		}
		if (this.subagentTasksChanged(previousState, nextState, transcriptUpdate)) {
			this.rebuildSubagentTasks();
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
			liveState: state.footer.liveState,
			liveStateKind: state.footer.liveStateKind,
			liveStateDetail: state.footer.liveStateDetail,
			turnStartedAtMs: this.turnStartedAtMs,
			completedDurationMs: this.completedDurationMs,
		});
	}

	private footerSignature(state: MycliShellState): string {
		return JSON.stringify(state.footer);
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

	private showApprovalSelector(approval: MycliShellPendingApproval): void {
		const selector = new ApprovalSelectorComponent({
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
		try {
			await this.options.onApprovalRespond?.(approval.decisionId, choice, approval);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unable to submit approval response.";
			this.addSystemNotice(message);
			throw error;
		}
	}

	private showClarificationSelector(clarification: MycliShellPendingClarification): void {
		const selector = new ClarificationSelectorComponent({
			clarification,
			onRespond: (response) => this.respondClarification(clarification, response),
			onCancel: () => {
				this.addSystemNotice("Question still waiting for an answer.");
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
		try {
			await this.options.onClarificationRespond?.(
				clarification.requestId,
				response,
				clarification,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unable to submit clarification response.";
			this.addSystemNotice(message);
			throw error;
		}
	}

	private rebuildHeader(): void {
		this.transcriptRenderRevision += 1;
		this.transcriptViewport.markContentChanged();
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

	private rebuildChat(tailOnly = false): void {
		this.transcriptRenderRevision += 1;
		const transcript = this.state.transcript?.length ? this.state.transcript : this.legacyTranscriptBlocks();
		if (transcript.length > 0) {
			const stablePrefixLength = this.syncChatBlocks(transcript, tailOnly);
			if (tailOnly) {
				this.transcriptViewport.markSectionTailChanged(this.chatContainer, stablePrefixLength);
			} else {
				this.transcriptViewport.markContentChanged();
			}
			return;
		}
		this.transcriptViewport.markContentChanged();
		this.chatBlocks.clear();
		this.projectedChatBlocks = [];
		this.transcriptProjection = null;
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
			const next = this.syncChatBlock(block, cached);
			this.chatBlocks.set(block.id, next);
			suffixComponents.push(next.component);
		}
		if (this.isCompletedLiveState(this.state.footer.liveState)) {
			suffixComponents.push(new TurnCompletedComponent(this.completedDurationMs ?? 0));
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
		const startedAtMs = this.turnStartedAtMs ?? this.now();
		this.turnStartedAtMs = startedAtMs;
		this.turnActivity = new TurnActivityComponent(this.ui, startedAtMs, this.now, {
			text: this.state.footer.liveState ?? "Running",
			detail: this.state.footer.liveStateDetail,
		});
		return this.turnActivity;
	}

	private syncChatBlock(block: ProjectedTranscriptBlock, cached?: ChatBlockComponent): ChatBlockComponent {
		if (block.kind === "message" && block.message.role === "assistant") {
			if (
				cached?.kind === "message" &&
				cached.role === "assistant" &&
				cached.component instanceof AssistantMessageComponent
			) {
				cached.component.updateMessage(
					block.message.text,
					block.message.thinking,
					block.message.thinkingHidden ?? true,
				);
				return cached;
			}
			return {
				kind: "message",
				signature: "assistant",
				role: "assistant",
				component: this.createMessageComponent(block.message),
			};
		}
		const signature = this.blockSignature(block);
		if (cached?.kind === block.kind && cached.signature === signature) return cached;
		if (cached?.kind === block.kind) {
			if (block.kind === "tool" && cached.component instanceof ToolExecutionComponent) {
				cached.component.updateTool(block.tool);
				cached.signature = signature;
				return cached;
			}
			if (block.kind === "file_change" && cached.component instanceof FileChangeComponent) {
				cached.component.updateFileChange(block.fileChange);
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
			if (
				block.kind === "command_result" &&
				cached.component instanceof CommandResultComponent
			) {
				cached.component.updateResult(block.commandResult);
				cached.signature = signature;
				return cached;
			}
		}
		if (block.kind === "tool") {
			return { kind: "tool", signature, component: new ToolExecutionComponent(block.tool) };
		}
		if (block.kind === "file_change") {
			return { kind: "file_change", signature, component: new FileChangeComponent(block.fileChange) };
		}
		if (block.kind === "bash") {
			return { kind: "bash", signature, component: new BashExecutionComponent(block.bash, this.now) };
		}
		if (block.kind === "plan") {
			return { kind: "plan", signature, component: new ProposedPlanComponent(block.plan) };
		}
		if (block.kind === "plan_update") {
			return { kind: "plan_update", signature, component: new PlanUpdateComponent(block.planUpdate) };
		}
		if (block.kind === "tool_group") {
			return { kind: "tool_group", signature, component: new CollapsedToolGroupComponent(block.group) };
		}
		if (block.kind === "diagnostic") {
			return { kind: "diagnostic", signature, component: new CommandDiagnosticComponent(block.diagnostic) };
		}
		if (block.kind === "background_terminals") {
			return {
				kind: "background_terminals",
				signature,
				component: new BackgroundTerminalsComponent(block.backgroundTerminals),
			};
		}
		if (block.kind === "command_result") {
			return {
				kind: "command_result",
				signature,
				component: new CommandResultComponent(block.commandResult),
			};
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
		this.stopTurnActivity();
		this.statusContainer.clear();
		if (this.isTurnActivityRunning(this.state)) {
			this.statusContainer.addChild(this.createTurnActivityComponent());
			return;
		}
		if (this.isCompletedLiveState(this.state.footer.liveState)) {
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
		const wasRunning = this.isTurnActivityRunning(previousState);
		const isRunning = this.isTurnActivityRunning(nextState);
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
		return state.footer.turnRunning ?? this.isRunningLiveState(
			state.footer.liveState,
			state.footer.liveStateKind,
		);
	}

	private isCompletedLiveState(liveState: string | undefined): boolean {
		return liveState?.trim().toLowerCase() === "completed";
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
		this.footerContainer.addChild(new Spacer(1));
		this.footerContainer.addChild(new FooterComponent(this.state.footer, {
			turnRunning: this.isTurnRunning(),
			hasQueuedInput: this.state.footer.hasPendingInput === true,
		}));
	}

	private async handleSubmit(text: string): Promise<void> {
		const input = text.trim();
		if (!input) {
			return;
		}
		if (input === "/") {
			this.editor.setText("");
			this.showCommandPalette();
			return;
		}
		if (isSlashCommandSubmission(input)) {
			this.editor.addToHistory(input);
			this.editor.setText("");
			try {
				await this.submitCommand(input);
			} catch (error) {
				this.restoreQueuedTextToEditor(input);
				throw error;
			}
			return;
		}
		const submitted = this.extractLocalImageAttachments(input);
		this.editor.addToHistory(input);
		this.editor.setText("");
		const startsNewTurn = !this.isTurnRunning() && !this.userTurnPendingStart;
		if (startsNewTurn) {
			this.lastSubmittedInput = {
				text: input,
				...(submitted.localImages.length ? { localImages: submitted.localImages } : {}),
			};
			this.lastSubmittedInputEligible = true;
			this.lastSubmittedActivitySignature = this.visibleTurnActivitySignature(this.state);
			this.userTurnPendingStart = true;
		}
		this.lastCtrlCAtMs = null;
		try {
			await this.options.onSubmit?.(submitted.text, { localImages: submitted.localImages });
		} catch (error) {
			if (startsNewTurn) this.userTurnPendingStart = false;
			this.restoreQueuedInputToEditor({
				text: input,
				...(submitted.localImages.length ? { localImages: submitted.localImages } : {}),
			});
			throw error;
		}
	}

	private extractLocalImageAttachments(input: string): { text: string; localImages: MycliShellLocalImageAttachment[] } {
		const pendingImages = this.pendingLocalImages.filter((image) => input.includes(image.placeholder));
		const localImages: MycliShellLocalImageAttachment[] = [...pendingImages];
		const text = input.replace(/(^|\s)@([^\s]+)(?=\s|$)/g, (match, prefix: string, path: string) => {
			if (!isLocalImageAttachmentPath(path)) {
				return match;
			}
			const placeholder = `[image #${localImages.length + 1}]`;
			localImages.push({ path, placeholder });
			return `${prefix}${placeholder}`;
		});
		this.pendingLocalImages = [];
		return { text: text.trim(), localImages };
	}

	private registerDroppedImageFile(path: string): string {
		const placeholder = `[image #${this.pendingLocalImages.length + 1}]`;
		this.pendingLocalImages.push({ path, placeholder });
		return placeholder;
	}

	private retainPendingImagesInText(text: string): void {
		if (this.pendingLocalImages.length === 0) {
			return;
		}
		this.pendingLocalImages = this.pendingLocalImages.filter((image) => text.includes(image.placeholder));
	}

	private promotePlainImagePathInput(text: string): boolean {
		const path = text.trim();
		if (!path || text.includes("[image #")) {
			return false;
		}
		if (path !== text || !path.startsWith("/") || !isLocalImageAttachmentPath(path)) {
			return false;
		}
		const placeholder = this.registerDroppedImageFile(path);
		this.editor.setText(placeholder);
		return true;
	}

	private async submitFollowUp(): Promise<void> {
		const input = this.editor.getText().trim();
		if (!input) {
			return;
		}
		const submitted = this.extractLocalImageAttachments(input);
		this.editor.addToHistory(input);
		this.editor.setText("");
		try {
			await (this.options.onFollowUp ?? this.options.onSubmit)?.(submitted.text, {
				localImages: submitted.localImages,
			});
		} catch (error) {
			this.restoreQueuedInputToEditor({
				text: input,
				...(submitted.localImages.length ? { localImages: submitted.localImages } : {}),
			});
			throw error;
		}
	}

	private async restoreQueuedInput(): Promise<void> {
		const queued = await this.options.onDequeueQueuedInput?.();
		if (!queued) {
			this.addSystemNotice("No queued message to restore.");
			return;
		}
		this.restoreQueuedInputToEditor(queued);
	}

	private async handleInterrupt(): Promise<void> {
		if (this.selectorActive) {
			if (this.approvalSurfaceDecisionId !== null || this.clarificationSurfaceRequestId !== null) {
				return;
			}
			this.restoreEditor();
			return;
		}
		if (this.isTurnRunning()) {
			await this.options.onInterrupt?.({
				rollbackUserInput: this.lastSubmittedInputEligible,
			});
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
			const now = this.now();
			const interrupting = this.state.footer.liveStateKind?.trim().toLowerCase() === "interrupting"
				|| this.state.footer.liveState?.trim().toLowerCase() === "interrupting";
			if (interrupting && this.lastCtrlCAtMs !== null && now - this.lastCtrlCAtMs <= 2000) {
				await (this.options.onInterruptExit ?? this.options.onExit)?.();
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
			if (interrupted && this.options.onInterruptExit) {
				await this.options.onInterruptExit();
			} else {
				await this.shutdown();
			}
			return;
		}
		this.lastCtrlCAtMs = now;
		this.addSystemNotice("Press Ctrl+C again to exit.");
	}

	private restoreQueuedTextToEditor(queued: string): void {
		const current = this.editor.getText().trim();
		this.editor.setText([queued, current].filter((text) => text.trim()).join("\n\n"));
	}

	private restoreQueuedInputToEditor(input: MycliShellQueuedInput | string): void {
		const text = typeof input === "string" ? input : input.text;
		if (typeof input !== "string") {
			const existing = new Map(this.pendingLocalImages.map((image) => [image.placeholder, image]));
			for (const image of input.localImages ?? []) {
				if (text.includes(image.placeholder) && !existing.has(image.placeholder)) {
					this.pendingLocalImages.push(image);
				}
			}
		}
		this.restoreQueuedTextToEditor(text);
	}

	private isTurnRunning(): boolean {
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

	private commands(): MycliShellCommandSpec[] {
		return this.options.commands ?? [];
	}

	private refreshAutocompleteProvider(): void {
		const slashCommands: SlashCommand[] = this.commands().map((command) => ({
			name: command.name.replace(/^\//, ""),
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
					: block.kind === "bash" && block.bash.expanded !== true,
			);
			this.toolDetailMode = hasCollapsed ? "expanded" : "collapsed";
		}
		this.setState(this.state);
		this.queueNativeTranscriptHistory(true);
	}

	private applyToolDetailMode(
		state: MycliShellState,
		transcriptUpdate?: TranscriptUpdateKind,
	): MycliShellState {
		if (this.toolDetailMode === "default") {
			this.toolDetailProjection = null;
			return state;
		}
		const mode = this.toolDetailMode;
		const expanded = mode === "expanded";
		const retained = this.toolDetailProjection;
		const previous = retained?.mode === mode ? retained : null;
		const sourceTools = retained && state.tools === retained.tools
			? retained.sourceTools
			: state.tools;
		const sourceBash = retained && state.bash === retained.bash
			? retained.sourceBash
			: state.bash;
		const sourceTranscript = retained && state.transcript === retained.transcript
			? retained.sourceTranscript
			: state.transcript;
		const toolUpdate = projectDetailArray(
			sourceTools,
			previous?.sourceTools,
			previous?.tools,
			transcriptUpdate,
			(tool) => tool.expanded === expanded ? tool : { ...tool, expanded },
		);
		const bashUpdate = projectDetailArray(
			sourceBash,
			previous?.sourceBash,
			previous?.bash,
			transcriptUpdate,
			(item) => item.expanded === expanded ? item : { ...item, expanded },
		);
		const toolById = detailIndex(toolUpdate, previous?.toolById);
		const bashById = detailIndex(bashUpdate, previous?.bashById);
		const transcript = sourceTranscript
			? projectDetailArray(
				sourceTranscript,
				previous?.sourceTranscript,
				previous?.transcript,
				transcriptUpdate,
				(block) => {
					if (block.kind === "tool") {
						const tool = toolById.get(block.tool.id) ?? (
							block.tool.expanded === expanded ? block.tool : { ...block.tool, expanded }
						);
						return tool === block.tool ? block : { ...block, tool };
					}
					if (block.kind === "bash") {
						const bash = bashById.get(block.bash.id) ?? (
							block.bash.expanded === expanded ? block.bash : { ...block.bash, expanded }
						);
						return bash === block.bash ? block : { ...block, bash };
					}
					return block;
				},
			).values
			: undefined;
		this.toolDetailProjection = {
			mode,
			sourceTools,
			tools: toolUpdate.values,
			toolById,
			sourceBash,
			bash: bashUpdate.values,
			bashById,
			sourceTranscript,
			transcript,
		};
		return {
			...state,
			tools: toolUpdate.values,
			bash: bashUpdate.values,
			transcript,
		};
	}

	private clearTranscript(): void {
		this.setState({
			...this.state,
			messages: [],
			tools: [],
			bash: [],
			transcript: [],
			pendingNotice: undefined,
		});
	}

	private setViewMode(rawMode: string): void {
		const mode = rawMode === "verbose" || rawMode === "focus" || rawMode === "default" ? rawMode : null;
		if (!mode) {
			this.addSystemNotice("Usage: /view default | /view verbose | /view focus");
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

	private showHotkeys(): void {
		this.addSystemNotice(
			[
				"Hotkeys",
				"ctrl+p commands · ? help",
				"enter send/steer · esc interrupt",
				"ctrl+l model · ctrl+o tools · ctrl+x permissions",
				"ctrl+c clear/exit · tab follow-up · alt+up/shift+left edit follow-up",
			].join("\n"),
		);
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

	private runAsyncAction(action: () => Promise<void>, fallback: string): void {
		void action().catch((error: unknown) => {
			const detail = error instanceof Error && error.message.trim()
				? error.message.trim()
				: fallback;
			this.addSystemNotice(detail === fallback ? fallback : `${fallback}: ${detail}`);
		});
	}

	private patchFooter(footerPatch: Partial<MycliShellState["footer"]>): void {
		this.setState({ ...this.state, footer: { ...this.state.footer, ...footerPatch } });
	}

	private async applySettingsChange(settings: MycliShellVisualSettings): Promise<void> {
		const previousSettings = this.state.settings;
		const optimisticState = this.ensureToolsVisible({ ...this.state, settings });
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
				const savedState = this.ensureToolsVisible({ ...this.state, settings: savedSettings });
				this.setState({
					...savedState,
					footer: {
						...savedState.footer,
						liveState: "Settings saved",
					},
				});
			}
		} catch (error) {
			const restoredState = this.ensureToolsVisible({ ...this.state, settings: previousSettings });
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
		const selected = await this.options.onModelSelect?.(model);
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
	}

	private async submitModelSelection(
		model: MycliShellModel,
		selector: ModelSelectorComponent,
		done: () => void,
	): Promise<void> {
		try {
			await this.selectModel(model);
			done();
		} catch (error) {
			selector.setError(error instanceof Error ? error.message : String(error));
		}
	}

	private async submitPermissionSelection(
		profile: MycliShellPermissionProfile,
		selector: PermissionSelectorComponent,
		done: () => void,
	): Promise<void> {
		try {
			const selected = await this.options.onPermissionSelect?.(profile);
			const permissions = selected ?? permissionStateWithActive(
				this.state.permissions ?? defaultPermissionState(),
				profile.id,
			);
			this.setState({ ...this.state, permissions });
			done();
			this.addSystemNotice(`Permissions updated to ${profile.label}`);
		} catch (error) {
			selector.setError(error instanceof Error ? error.message : String(error));
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
			selector.setError(error instanceof Error ? error.message : String(error));
		}
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

function defaultPermissionState(): MycliShellPermissionState {
	return {
		active: "workspace",
		commandAllowanceCount: 0,
		profiles: [
			{
				id: "workspace",
				label: "Ask for approval",
				description: "Read and edit the current workspace; ask before network or outside access.",
				current: true,
			},
			{
				id: "full-access",
				label: "Full Access",
				description: "Access files and network without approval.",
				current: false,
			},
			{
				id: "read-only",
				label: "Read Only",
				description: "Read workspace files; ask before edits or network.",
				current: false,
			},
		],
	};
}

function permissionStateWithActive(
	state: MycliShellPermissionState,
	active: MycliShellPermissionProfile["id"],
): MycliShellPermissionState {
	return {
		...state,
		active,
		profiles: state.profiles.map((profile) => ({
			...profile,
			current: profile.id === active,
		})),
	};
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

function formatElapsedCompact(elapsedSeconds: number): string {
	if (elapsedSeconds < 60) {
		return `${elapsedSeconds}s`;
	}
	if (elapsedSeconds < 3600) {
		const minutes = Math.floor(elapsedSeconds / 60);
		const seconds = elapsedSeconds % 60;
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	const hours = Math.floor(elapsedSeconds / 3600);
	const minutes = Math.floor((elapsedSeconds % 3600) / 60);
	const seconds = elapsedSeconds % 60;
	return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}
