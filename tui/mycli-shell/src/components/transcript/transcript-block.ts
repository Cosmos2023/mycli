import type { MycliShellMessage } from "../../model.ts";
import type { ProjectedTranscriptBlock } from "../../transcript/transcript-projection.ts";
import { Text } from "../../tui-core/components/text.ts";
import type { Component } from "../../tui-core/tui.ts";
import { theme } from "../../theme/theme.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { ApprovalDecisionComponent } from "./approval-decision.ts";
import { BackgroundTerminalsComponent } from "./background-terminals.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ClarificationResponseComponent } from "./clarification-response.ts";
import { CollapsedToolGroupComponent } from "./collapsed-tool-group.ts";
import { CommandDiagnosticComponent } from "./command-diagnostic.ts";
import { CommandResultComponent } from "./command-result.ts";
import { FileChangeComponent } from "./file-change.ts";
import { NoticeMessageComponent } from "./notice-message.ts";
import { PlanUpdateComponent } from "./plan-update.ts";
import { ProposedPlanComponent } from "./proposed-plan.ts";
import { ProviderAttemptComponent } from "./provider-attempt.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { TranscriptSeparatorComponent } from "./transcript-separator.ts";
import { TurnCompletedComponent } from "./turn-completed.ts";
import { UserMessageComponent } from "./user-message.ts";
import { WebSearchComponent } from "./web-search.ts";

export interface TranscriptBlockOptions {
	readonly hideThinking?: boolean;
	readonly now?: () => number;
}

export interface RenderedTranscriptBlock {
	readonly kind: ProjectedTranscriptBlock["kind"];
	signature: string;
	readonly component: Component;
}

export function createTranscriptBlockComponent(
	block: ProjectedTranscriptBlock,
	options: TranscriptBlockOptions = {},
): Component {
	switch (block.kind) {
		case "message":
			return createMessageComponent(block.message, options.hideThinking);
		case "assistant_separator":
			return new TranscriptSeparatorComponent();
		case "turn_completed":
			return new TurnCompletedComponent(block.turnCompleted.durationMs, block.turnCompleted.id);
		case "web_search":
			return new WebSearchComponent(block.webSearch);
		case "clarification":
			return new ClarificationResponseComponent(block.clarification);
		case "provider_attempt":
			return new ProviderAttemptComponent(block.providerAttempt);
		case "plan":
			return new ProposedPlanComponent(block.plan);
		case "plan_update":
			return new PlanUpdateComponent(block.planUpdate);
		case "tool":
			return new ToolExecutionComponent(block.tool);
		case "file_change":
			return new FileChangeComponent(block.fileChange);
		case "bash":
			return new BashExecutionComponent(block.bash, options.now);
		case "diagnostic":
			return new CommandDiagnosticComponent(block.diagnostic);
		case "background_terminals":
			return new BackgroundTerminalsComponent(block.backgroundTerminals);
		case "command_result":
			return new CommandResultComponent(block.commandResult);
		case "tool_group":
			return new CollapsedToolGroupComponent(block.group);
	}
}

export function syncTranscriptBlock(
	block: ProjectedTranscriptBlock,
	cached: RenderedTranscriptBlock | undefined,
	options: TranscriptBlockOptions,
): RenderedTranscriptBlock {
	if (block.kind === "message" && block.message.role === "assistant") {
		if (cached?.kind === "message" && cached.component instanceof AssistantMessageComponent) {
			cached.component.updateMessage(
				block.message.text,
				block.message.thinking,
				options.hideThinking ?? block.message.thinkingHidden ?? true,
			);
			return cached;
		}
		return { kind: block.kind, signature: "assistant", component: createTranscriptBlockComponent(block, options) };
	}
	const signature = JSON.stringify(block);
	if (cached?.kind === block.kind) {
		if (cached.signature === signature) return cached;
		const component = cached.component;
		if (block.kind === "tool" && component instanceof ToolExecutionComponent) {
			component.updateTool(block.tool);
		} else if (block.kind === "file_change" && component instanceof FileChangeComponent) {
			component.updateFileChange(block.fileChange);
		} else if (block.kind === "bash" && component instanceof BashExecutionComponent) {
			component.updateBash(block.bash);
		} else if (block.kind === "tool_group" && component instanceof CollapsedToolGroupComponent) {
			component.updateGroup(block.group);
		} else if (block.kind === "command_result" && component instanceof CommandResultComponent) {
			component.updateResult(block.commandResult);
		} else {
			return { kind: block.kind, signature, component: createTranscriptBlockComponent(block, options) };
		}
		cached.signature = signature;
		return cached;
	}
	return { kind: block.kind, signature, component: createTranscriptBlockComponent(block, options) };
}

function createMessageComponent(message: MycliShellMessage, hideThinking?: boolean): Component {
	if (message.role === "user") return new UserMessageComponent(message.text);
	if (message.role === "assistant") {
		return new AssistantMessageComponent(message.text, message.thinking, hideThinking ?? message.thinkingHidden ?? true);
	}
	if (message.id.startsWith("approval-decision:")) {
		return new ApprovalDecisionComponent(message.text, message.role === "warning");
	}
	return message.role === "system"
		? new Text(theme.fg("muted", message.text), 1, 0)
		: new NoticeMessageComponent(message);
}
