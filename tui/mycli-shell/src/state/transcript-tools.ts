import {
	gatewayToolLifecycleRecord,
	parseGatewayToolRecord,
	projectTerminalInteraction,
	type GatewayToolRecord,
} from "@mycli/contracts";
import type {
	MycliShellFileChange,
	MycliShellFileChangeEntry,
	MycliShellTool,
	MycliShellToolStatus,
	MycliShellVisualSettings,
} from "../model.ts";
import { booleanValue, nextId, numberValue, recordValue, stringValue, textValue } from "./payload-values.ts";
import type { RuntimeTranscriptItem } from "./runtime-state-model.ts";
import { findToolIndex, toolRecordFromTranscriptItem } from "./transcript-records.ts";
import {
	findShellTranscriptIndex,
	isShellOutputLifecycle,
	mergeShellOutputIntoExecution,
	removeToolLifecycleItem,
} from "./transcript-shell.ts";

const SEMANTIC_TOOL_ROW_NAMES = new Set([
	"askuserquestion",
	"followuptask",
	"interruptagent",
	"killshell",
	"listagents",
	"sendmessage",
	"spawnagent",
	"toolsearch",
	"updateplan",
	"waitagent",
]);

export function toolFromTranscriptItem(
	item: RuntimeTranscriptItem,
	record: GatewayToolRecord,
	workspace: string,
	toolDetailsDefault: MycliShellVisualSettings["toolDetailsDefault"] = "collapsed",
): MycliShellTool {
	return {
		id: item.id,
		name: record.name,
		terminalInteraction: record.terminal_interaction,
		args: compactTarget(commandTargetPreview(record.name, record.target ?? null), workspace) ?? undefined,
		status: record.status,
		durationMs: record.duration_ms,
		mutating: record.mutating,
		contentPreview: record.content_preview,
		contentLineCount: record.content_line_count,
		diffPreview: record.diff_preview,
		summaryPreview: record.summary_preview,
		detailPreview: record.detail_preview,
		presentation: record.presentation,
		displayTruncated: record.display_truncated,
		displayOmittedChars: record.display_omitted_chars,
		hidden: false,
		outputPreview: record.output_preview,
		errorPreview: record.error_preview,
		hiddenLineCount: record.hidden_line_count,
		expanded: item.folded === false || (item.folded === undefined && toolDetailsDefault === "expanded"),
	};
}

type ToolDisplay = {
	target?: string;
	status: MycliShellToolStatus;
	summary: string;
	detail?: string;
	error?: string;
	metrics: Record<string, string | number | boolean>;
	truncated: boolean;
	omittedChars: number;
	presentation: string;
	fileChanges: MycliShellFileChangeEntry[];
};

const DISPLAY_PRESENTATIONS = new Set([
	"tool",
	"context",
	"mutation",
	"shell",
	"skill",
	"web",
	"diagnostic",
	"control",
	"external",
]);

function toolDisplayFromMetadata(metadata: Record<string, unknown>): ToolDisplay | null {
	const display = recordValue(metadata.display);
	const rawStatus = stringValue(display.status);
	const summary = typeof display.summary === "string" ? display.summary : null;
	if (!rawStatus || summary === null) return null;
	let status: MycliShellToolStatus;
	if (rawStatus === "success" || rawStatus === "error" || rawStatus === "cancelled") {
		status = rawStatus;
	} else if (rawStatus === "running" || rawStatus === "waiting") {
		status = "running";
	} else {
		return null;
	}
	const rawPresentation = stringValue(display.presentation) ?? "tool";
	return {
		target: stringValue(display.target) ?? undefined,
		status,
		summary,
		detail: textValue(display.detail) ?? undefined,
		error: textValue(display.error) ?? undefined,
		metrics: scalarDisplayMetrics(display.metrics),
		truncated: booleanValue(display.truncated) ?? false,
		omittedChars: numberValue(display.omitted_chars) ?? 0,
		presentation: DISPLAY_PRESENTATIONS.has(rawPresentation) ? rawPresentation : "tool",
		fileChanges: fileChangeEntriesFromUnknown(display.file_changes),
	};
}

export function fileChangeFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellFileChange | null {
	if (item.tool_record && !item.tool_record.mutating) return null;
	const metadata = recordValue(item.metadata);
	const display = toolDisplayFromMetadata(metadata);
	const name = stringValue(metadata.tool_name) ?? stringValue(metadata.name) ?? item.text.split(/\s+/, 1)[0] ?? "Tool";
	const recognizedMutation = isFileMutationTool(name);
	const directFiles = fileChangeEntriesFromUnknown(metadata.file_changes);
	if (!recognizedMutation && directFiles.length === 0 && (!display || display.fileChanges.length === 0)) {
		return null;
	}
	const status = display?.status ?? toolStatus(metadata);
	const proposal = metadata.file_mutation_proposal === true;
	if ((status === "running" && !proposal) || status === "cancelled") return null;

	const files = display?.fileChanges.length
		? display.fileChanges
		: directFiles.length > 0
			? directFiles
			: legacyFileChangeEntries(name, metadata, display?.target);
	const summary = display?.summary ?? stringValue(metadata.summary) ?? item.text;
	const target =
		display?.target ??
		stringValue(metadata.path) ??
		stringValue(recordValue(metadata.raw_payload).path) ??
		undefined;
	const callId = stringValue(metadata.call_id) ?? undefined;

	if (status === "error" && recognizedMutation) {
		return {
			id: item.id,
			callId,
			status: "error",
			summary: summary || "Failed to update file",
			target,
			files: [],
			error: display?.error ?? textValue(metadata.error) ?? undefined,
		};
	}
	if (files.length > 0) {
		return { id: item.id, callId, status: "success", summary, target, files };
	}
	if (recognizedMutation && summary.trim().toLowerCase().startsWith("no changes")) {
		return { id: item.id, callId, status: "unchanged", summary, target, files: [] };
	}
	return null;
}

export function fileChangeEntriesFromUnknown(value: unknown): MycliShellFileChangeEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, 64)
		.map(fileChangeEntryFromUnknown)
		.filter((entry): entry is MycliShellFileChangeEntry => entry !== null);
}

function fileChangeEntryFromUnknown(value: unknown): MycliShellFileChangeEntry | null {
	const record = recordValue(value);
	if (record.version !== 1) return null;
	const kind = fileChangeKind(record.kind);
	const path = stringValue(record.path);
	if (!kind || !path) return null;
	const diff = textValue(record.diff) ?? "";
	const counts = countDiffLines(diff);
	return {
		version: 1,
		kind,
		path,
		previousPath: stringValue(record.previous_path) ?? stringValue(record.previousPath) ?? undefined,
		diff,
		addedLines: nonnegativeInteger(record.added_lines) ?? nonnegativeInteger(record.addedLines) ?? counts.added,
		removedLines: nonnegativeInteger(record.removed_lines) ?? nonnegativeInteger(record.removedLines) ?? counts.removed,
		truncated: booleanValue(record.truncated) ?? false,
		omittedChars: nonnegativeInteger(record.omitted_chars) ?? nonnegativeInteger(record.omittedChars) ?? 0,
		language: stringValue(record.language) ?? languageForPath(path),
	};
}

function legacyFileChangeEntries(
	name: string,
	metadata: Record<string, unknown>,
	target: string | undefined,
): MycliShellFileChangeEntry[] {
	const normalized = normalizeToolName(name);
	const rawPayload = recordValue(metadata.raw_payload);
	const rawStatus = (stringValue(rawPayload.status) ?? stringValue(metadata.status) ?? "").toLowerCase();
	const legacyChanges = Array.isArray(metadata.file_changes) ? metadata.file_changes.map(recordValue) : [];
	const legacyKind = legacyChanges.map((change) => normalizeToolName(stringValue(change.kind) ?? ""));
	const safelyUpdated =
		normalized === "edit" ||
		normalized === "editfile" ||
		normalized === "patch" ||
		normalized === "patchfile" ||
		["edited", "patched", "overwritten", "written"].includes(rawStatus) ||
		legacyKind.some((kind) => kind === "edit" || kind === "patch");
	if (!safelyUpdated) return [];
	const diff = diffPreviewForTool(metadata);
	const path = target ?? stringValue(metadata.path) ?? stringValue(rawPayload.path);
	if (!diff || !path) return [];
	const counts = countDiffLines(diff);
	return [{
		version: 1,
		kind: "update",
		path,
		diff,
		addedLines: counts.added,
		removedLines: counts.removed,
		truncated: booleanValue(metadata.diff_truncated) ?? false,
		omittedChars: 0,
		language: languageForPath(path),
	}];
}

function fileChangeKind(value: unknown): MycliShellFileChangeEntry["kind"] | null {
	if (value === "move") return "rename";
	return value === "add" || value === "update" || value === "delete" || value === "rename"
		? value
		: null;
}

function countDiffLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

function nonnegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function languageForPath(path: string): string | undefined {
	const leaf = path.replace(/\\/g, "/").split("/").pop() ?? "";
	const dot = leaf.lastIndexOf(".");
	return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1).toLowerCase() : undefined;
}

function isFileMutationTool(name: string): boolean {
	return new Set(["write", "writefile", "edit", "editfile", "patch", "patchfile"]).has(normalizeToolName(name));
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[_-]/g, "");
}

export function suppressGenericToolRow(tool: MycliShellTool): boolean {
	const interaction = tool.terminalInteraction;
	if (interaction?.kind === "poll" && (tool.status === "running"
		|| (interaction.interaction_succeeded === true && interaction.process_running === false)
		|| (tool.status === "success" && interaction.process_running !== true))) return true;
	return tool.status !== "error"
		&& tool.status !== "cancelled"
		&& SEMANTIC_TOOL_ROW_NAMES.has(normalizeToolName(tool.name));
}

export function fileChangeFallbackText(change: MycliShellFileChange): string {
	if (change.status === "error") return `${change.summary}${change.error ? `: ${change.error}` : ""}`;
	if (change.status === "unchanged") return change.target ? `No changes to ${change.target}` : change.summary;
	if (change.files.length === 1) {
		const file = change.files[0]!;
		const verb = file.kind === "add" ? "Added" : file.kind === "delete" ? "Deleted" : file.kind === "rename" ? "Renamed" : "Edited";
		return `${verb} ${file.path} (+${file.addedLines} -${file.removedLines})`;
	}
	const added = change.files.reduce((total, file) => total + file.addedLines, 0);
	const removed = change.files.reduce((total, file) => total + file.removedLines, 0);
	return `Edited ${change.files.length} files (+${added} -${removed})`;
}

function scalarDisplayMetrics(value: unknown): Record<string, string | number | boolean> {
	const raw = recordValue(value);
	const metrics: Record<string, string | number | boolean> = {};
	for (const [key, item] of Object.entries(raw).slice(0, 16)) {
		if (typeof item === "string" || typeof item === "boolean") {
			metrics[key] = item;
		} else if (typeof item === "number" && Number.isFinite(item)) {
			metrics[key] = item;
		}
	}
	return metrics;
}

export function diffPreviewForTool(metadata: Record<string, unknown>): string | undefined {
	return (
		stringValue(metadata.diff) ??
		stringValue(recordValue(metadata.raw_payload).diff) ??
		stringValue(recordValue(metadata.details).diff) ??
		stringValue(recordValue(recordValue(metadata.raw_payload).details).diff) ??
		undefined
	);
}

function toolStatus(metadata: Record<string, unknown>): MycliShellToolStatus {
	if (metadata.status === "running") return "running";
	if (metadata.status === "failed" || metadata.success === false) return "error";
	if (metadata.success === true || metadata.status === "done") return "success";
	return "running";
}

function isShellTool(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "bash" || lower === "shell" || lower === "run_shell";
}

function commandTargetPreview(name: string, target: string | null): string | null {
	if (!target || !isShellTool(name)) {
		return target;
	}
	const lines = target
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length <= 1) {
		return target;
	}
	const firstLine = lines[0] ?? "command";
	return `${firstLine} ... (${lines.length} lines)`;
}

export function applyToolLifecycle(items: RuntimeTranscriptItem[], method: string, params: Record<string, unknown>): RuntimeTranscriptItem[] {
	const priorIndex = findToolIndex(items, params);
	const prior = priorIndex < 0 ? undefined : toolRecordFromTranscriptItem(items[priorIndex]!);
	const incomingInteraction = projectTerminalInteraction(params.terminal_interaction
		?? recordValue(params.tool_record).terminal_interaction);
	const interaction = incomingInteraction ? { ...prior?.terminal_interaction, ...incomingInteraction } : prior?.terminal_interaction;
	if (interaction) {
		const shellIndex = findShellTranscriptIndex(items, interaction.shell_id, undefined);
		const shellRecord = shellIndex < 0 ? undefined : toolRecordFromTranscriptItem(items[shellIndex]!);
		const terminalInteraction = projectTerminalInteraction({
			...interaction,
			command_preview: interaction.command_preview ?? shellRecord?.shell?.command_preview ?? shellRecord?.target,
		});
		params = { ...params, terminal_interaction: terminalInteraction,
			tool_record: { ...gatewayToolLifecycleRecord(method === "tool.complete" || method === "tool.failed" ? method : "tool.start", params),
				terminal_interaction: terminalInteraction } };
	}
	if (isShellOutputLifecycle(params) && !interaction && method !== "tool.failed") {
		const withoutPollingItem = removeToolLifecycleItem(items, params);
		if (method !== "tool.complete") {
			return withoutPollingItem;
		}
		const merged = mergeShellOutputIntoExecution(withoutPollingItem, params);
		if (merged !== null) {
			return merged;
		}
		return withoutPollingItem;
	}
	const rawPayload = recordValue(params.raw_payload);
	const backgroundStillRunning =
		method === "tool.complete" &&
		isShellTool(stringValue(params.name) ?? stringValue(params.tool_name) ?? "") &&
		stringValue(rawPayload.status) === "running";
	const metadata = {
		...params,
		tool_name: stringValue(params.name) ?? stringValue(params.tool_name) ?? "Tool",
		status: method === "tool.failed" ? "failed" : method === "tool.complete" && !backgroundStillRunning ? "done" : "running",
	};
	const matchIndex = findToolIndex(items, metadata);
	const previous = matchIndex >= 0 ? items[matchIndex] : undefined;
	const item = {
		id: matchIndex >= 0 ? items[matchIndex]!.id : nextId("tool"),
		type: "tool_summary",
		text: lifecycleToolText(metadata),
		folded: true,
		metadata: matchIndex >= 0 ? { ...recordValue(items[matchIndex]!.metadata), ...metadata } : metadata,
	};
	const incomingRecord = params.tool_record === undefined
		? previous?.tool_record ? gatewayToolLifecycleRecord(method === "tool.complete" || method === "tool.failed" ? method : "tool.start", params) : undefined
		: parseGatewayToolRecord(params.tool_record);
	const updated = incomingRecord === undefined ? item : {
		...item,
		tool_record: mergeToolLifecycleRecord(previous ? toolRecordFromTranscriptItem(previous) : undefined, incomingRecord),
	};
	return matchIndex >= 0 ? [...items.slice(0, matchIndex), updated, ...items.slice(matchIndex + 1)] : [...items, updated];
}

function mergeToolLifecycleRecord(previous: GatewayToolRecord | undefined, incoming: GatewayToolRecord): GatewayToolRecord {
	const merged = { ...previous, ...incoming, ...(incoming.shell ? { shell: { ...previous?.shell, ...incoming.shell } } : {}) };
	// Shell lifecycle events remain authoritative after the tool invocation returns.
	return previous?.shell && (previous.shell.sequence !== undefined || previous.presentation === "shell")
		&& incoming.shell?.sequence === undefined
		? { ...merged, status: previous.status, target: previous.target,
			summary_preview: previous.summary_preview, detail_preview: previous.detail_preview,
			output_preview: previous.output_preview, presentation: previous.presentation,
			shell: { ...incoming.shell, ...previous.shell } }
		: merged;
}

export function hasMatchingFileMutationProposal(
	items: RuntimeTranscriptItem[],
	approval: Record<string, unknown>,
): boolean {
	const callId = stringValue(approval.call_id)
		?? stringValue(approval.callId)
		?? stringValue(approval.decision_id)
		?? stringValue(approval.decisionId);
	if (!callId) return false;
	return items.some((item) => {
		if (item.type !== "tool_summary") return false;
		const metadata = recordValue(item.metadata);
		return metadata.file_mutation_proposal === true
			&& stringValue(metadata.call_id) === callId;
	});
}

export function fileMutationTargetPreview(preview: string, toolName: string): string {
	const prefix = `${toolName} `;
	return preview.toLowerCase().startsWith(prefix.toLowerCase())
		? preview.slice(prefix.length).trim() || toolName
		: preview;
}

function lifecycleToolText(metadata: Record<string, unknown>): string {
	const name = stringValue(metadata.tool_name) ?? "Tool";
	const target =
		stringValue(metadata.path) ??
		stringValue(metadata.query) ??
		stringValue(metadata.command) ??
		stringValue(metadata.context) ??
		stringValue(metadata.summary) ??
		stringValue(metadata.args_preview);
	return target ? `${name} ${target}` : name;
}

function compactTarget(value: string | null, workspace: string): string | null {
	if (!value) return null;
	const normalizedWorkspace = workspace.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalizedValue = value.replaceAll("\\", "/");
	if (normalizedWorkspace && normalizedValue.startsWith(`${normalizedWorkspace}/`)) {
		return normalizedValue.slice(normalizedWorkspace.length + 1);
	}
	return normalizedValue;
}
