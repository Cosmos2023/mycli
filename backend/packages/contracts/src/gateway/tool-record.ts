import type { GatewayShellRecord, GatewayToolRecord } from "../generated/gateway-tool-record.ts";
import { projectTerminalInteraction } from "./terminal-interaction.ts";
import { readErrorContext } from "../errors/error-context.ts";
import { errorSummary } from "../errors/presentation.ts";

type Metadata = Readonly<Record<string, unknown>>;
type ToolStatus = GatewayToolRecord["status"];
export const GATEWAY_TOOL_PREVIEW_MAX_CHARS = 8192;
const PRESENTATIONS: readonly GatewayToolRecord["presentation"][] = [
	"tool", "context", "mutation", "shell", "skill", "web", "diagnostic", "control", "external",
];

export function projectGatewayToolRecord(input: {
	readonly text: string;
	readonly metadata?: Metadata;
}): GatewayToolRecord {
	const metadata = input.metadata ?? {};
	const name = text(metadata.tool_name, 256) ?? text(metadata.name, 256)
		?? text(input.text.split(/\s+/, 1)[0], 256) ?? "Tool";
	const raw = record(metadata.raw_payload);
	const args = record(metadata.arguments);
	const display = record(metadata.display);
	const displayStatus = normalizedDisplayStatus(display.status);
	const hasDisplay = displayStatus !== undefined && typeof display.summary === "string";
	const metrics = hasDisplay ? record(display.metrics) : {};
	const status = hasDisplay ? displayStatus : legacyStatus(metadata);
	const isWrite = ["write", "write_file"].includes(name.toLowerCase());
	const mutating = (hasDisplay && display.presentation === "mutation")
		|| /edit|write|patch/u.test(name.toLowerCase()) || Array.isArray(metadata.file_changes);
	const content = hasDisplay
		? mutating && isWrite ? preview(display.detail) : undefined
		: isWrite ? text(metadata.content_preview) ?? text(args.content) ?? text(metadata.content)
			?? text(raw.content) ?? text(record(raw.arguments).content) : undefined;
	const diff = hasDisplay
		? mutating && !isWrite ? preview(display.detail) : undefined
		: text(metadata.diff) ?? text(raw.diff) ?? text(record(metadata.details).diff) ?? text(record(raw.details).diff);
	const output = hasDisplay ? text(display.summary)
		: status === "success" && mutating && (content || diff) ? undefined
			: preview(metadata.summary) ?? preview(metadata.output_preview)
				?? (isShell(name) ? preview(metadata.stdout) ?? preview(metadata.stderr)
					: status === "success" ? preview(input.text) : undefined);
	const target = hasDisplay ? text(display.target)
		: text(metadata.skill_name) ?? text(raw.skill_name) ?? text(args.skill_name)
			?? (name.toLowerCase() === "skill" ? text(args.name) : undefined)
			?? text(metadata.path) ?? text(raw.path) ?? text(args.file_path) ?? text(args.path)
			?? text(metadata.command) ?? text(raw.command) ?? text(metadata.query) ?? text(raw.query)
			?? text(metadata.context) ?? text(metadata.args_preview)
			?? text(input.text.startsWith(name) ? input.text.slice(name.length) : input.text);
	const truncated = hasDisplay ? display.truncated === true
		: metadata.summary_truncated === true || metadata.error_truncated === true;
	const hidden = truncated ? 1 : !hasDisplay && content ? Math.max(0, lineCount(content) - 10) || undefined : undefined;
	const presentation = PRESENTATIONS.find((value) => value === display.presentation) ?? "tool";
	const terminalInteraction = projectTerminalInteraction(metadata.terminal_interaction);
	const readSummary = !hasDisplay && status === "success" ? readRangeSummary(name, metadata) : undefined;
	const errorContext = status === "error" || status === "cancelled" ? readErrorContext(metadata.error_context) : undefined;
	const result: GatewayToolRecord = definedFields({
		version: 1,
		kind: "tool_execution",
		name,
		call_id: text(metadata.call_id, 512) ?? text(metadata.callId, 512),
		status,
		...(terminalInteraction ? { terminal_interaction: terminalInteraction } : {}),
		mutating,
		target,
		duration_ms: hasDisplay ? number(metrics.duration_ms) : number(metadata.duration_ms)
			?? number(typeof metadata.duration_s === "number" ? metadata.duration_s * 1000 : undefined),
		content_preview: content,
		content_line_count: count(hasDisplay ? metrics.line_count : metadata.content_line_count)
			?? (content ? lineCount(content) : undefined),
		diff_preview: diff,
		output_preview: output,
		error_preview: errorContext ? errorSummary(errorContext)
			: hasDisplay ? preview(display.error) : text(metadata.error) ?? (status === "error" ? preview(input.text) : undefined),
		hidden_line_count: hidden,
		...(readSummary ? { summary_preview: readSummary } : {}),
		...(hasDisplay ? {
			presentation,
			summary_preview: text(display.summary),
			detail_preview: content || diff ? undefined : preview(display.detail),
			display_truncated: truncated,
			display_omitted_chars: count(display.omitted_chars) ?? 0,
		} : {}),
		...(isShell(name) ? { shell: shellRecord(metadata, metrics, hasDisplay && truncated ? count(display.omitted_chars) ?? 0 : undefined) } : {}),
	});
	return Object.freeze({ ...result, ...(errorContext ? { error_context: errorContext } : {}) }) as GatewayToolRecord;
}

function readRangeSummary(name: string, metadata: Metadata): string | undefined {
	if (!["read", "read_file"].includes(name.toLowerCase())) return undefined;
	const shown = count(metadata.shownLines);
	const total = count(metadata.totalLines);
	const start = count(metadata.actualStartLine);
	const end = count(metadata.actualEndLine);
	if (shown === undefined || total === undefined || shown > total) return undefined;
	const unit = count(metadata.rows) !== undefined ? "Rows" : "Lines";
	let summary: string;
	if (shown === 0) summary = total === 0 ? "Empty file" : `0 ${unit.toLowerCase()} read (${total} total)`;
	else if (start && end !== undefined && end <= total && end - start + 1 === shown) {
		summary = `${unit} ${start}-${end} of ${total}`;
	} else return undefined;
	return metadata.dedup === true ? `${summary} (unchanged)` : summary;
}

export function gatewayToolLifecycleRecord(
	method: "tool.start" | "tool.complete" | "tool.failed",
	params: Metadata,
): GatewayToolRecord {
	const name = text(params.name, 256) ?? text(params.tool_name, 256) ?? "Tool";
	const backgroundRunning = method === "tool.complete" && isShell(name)
		&& (record(params.raw_payload).status === "running"
			|| ["running", "running_background", "running_foreground"].includes(String(params.process_state)));
	const target = text(params.path) ?? text(params.query) ?? text(params.command)
		?? text(params.context) ?? text(params.summary) ?? text(params.args_preview);
	return projectGatewayToolRecord({
		text: target ? `${name} ${target}` : name,
		metadata: {
			...params,
			tool_name: name,
			status: method === "tool.failed" ? "failed"
				: method === "tool.complete" && !backgroundRunning ? "done" : "running",
		},
	});
}

function shellRecord(metadata: Metadata, metrics: Metadata, omitted?: number): GatewayShellRecord {
	return Object.freeze(definedFields({
		command_preview: text(metadata.command_preview),
		description: text(metadata.description),
		shell_id: text(metadata.shell_id, 512) ?? text(metrics.shell_id, 512),
		background: boolean(metadata.background),
		process_state: text(metadata.process_state, 100),
		transport: text(metadata.transport, 100),
		tty: boolean(metadata.tty),
		yielded: boolean(metadata.yielded),
		terminal_state: text(metadata.terminal_state, 100),
		exit_code: integer(metadata.exit_code) ?? integer(metrics.exit_code),
		sequence: count(metadata.shell_sequence),
		started_at: text(metadata.started_at, 100),
		completed_at: text(metadata.completed_at, 100),
		output_chars: count(metadata.output_chars),
		omitted_output_chars: count(metadata.omitted_output_chars) ?? omitted,
		cleanup_result: text(metadata.cleanup_result, 100),
		shell_kind: text(metadata.shell_kind, 100),
		shell_edition: text(metadata.shell_edition, 100),
	}));
}

function definedFields<T extends object>(value: T): T {
	for (const key of Object.keys(value) as (keyof T)[]) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

function legacyStatus(metadata: Metadata): ToolStatus {
	if (metadata.status === "running") return "running";
	if (metadata.status === "cancelled" || metadata.status === "interrupted") return "cancelled";
	if (metadata.status === "failed" || metadata.success === false) return "error";
	if (metadata.success === true || metadata.status === "done" || metadata.status === "completed") return "success";
	return "running";
}

function normalizedDisplayStatus(value: unknown): ToolStatus | undefined {
	if (value === "success" || value === "error" || value === "cancelled") return value;
	return value === "running" || value === "waiting" ? "running" : undefined;
}

function isShell(name: string): boolean {
	return ["bash", "shell", "run_shell"].includes(name.toLowerCase());
}

function lineCount(value: string): number {
	const trimmed = value.replace(/\n+$/gu, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

function record(value: unknown): Metadata {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Metadata : {};
}

function text(value: unknown, limit = GATEWAY_TOOL_PREVIEW_MAX_CHARS): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function preview(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, GATEWAY_TOOL_PREVIEW_MAX_CHARS) : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
	return number(value) !== undefined && Number.isSafeInteger(value) ? value as number : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
