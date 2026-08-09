import { DEFAULT_QUEUE_CAPACITY } from "@mycli/core";
import {
	SUBAGENT_TASK_OUTPUT_REFERENCE_MAX_CHARS,
	type SubagentTaskRecord,
} from "@mycli/storage";

export const SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS = 32_000;
export const SUBAGENT_NOTIFICATION_MAX_BYTES = DEFAULT_QUEUE_CAPACITY.maxTextBytes;

export function serializeSubagentTaskNotification(
	record: SubagentTaskRecord,
	options: { readonly outputFile?: string } = {},
): string | undefined {
	if (record.status === "queued" || record.status === "running") return undefined;
	const result = terminalResult(record).slice(0, SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS);
	const summary = (result.split(/\r?\n/u, 1)[0]?.trim() || `Subagent ${record.status}`).slice(0, 500);
	const outputFile = options.outputFile?.slice(0, SUBAGENT_TASK_OUTPUT_REFERENCE_MAX_CHARS);
	const beforeResult = [
		"<task-notification>",
		`<task-id>${escapeXml(record.taskId)}</task-id>`,
		"<task-type>local_agent</task-type>",
		`<child-session-id>${escapeXml(record.childSessionId)}</child-session-id>`,
		...(outputFile ? [`<output-file>${escapeXml(outputFile)}</output-file>`] : []),
		`<status>${record.status}</status>`,
		...(record.completedAt ? [`<completed-at>${escapeXml(record.completedAt)}</completed-at>`] : []),
		`<summary>${escapeXml(summary)}</summary>`,
	];
	const afterResult = [
		`<agent>${escapeXml(record.profileId)}</agent>`,
		...(record.payload.outputReference
			? [`<output-reference>${escapeXml(record.payload.outputReference)}</output-reference>`]
			: []),
		"</task-notification>",
	];
	const fixed = [...beforeResult, "<result></result>", ...afterResult].join("\n");
	const resultByteBudget = Math.max(
		0,
		SUBAGENT_NOTIFICATION_MAX_BYTES - Buffer.byteLength(fixed, "utf8"),
	);
	return [
		...beforeResult,
		`<result>${escapeXmlWithinBytes(result, resultByteBudget)}</result>`,
		...afterResult,
	].join("\n");
}

function terminalResult(record: SubagentTaskRecord): string {
	if (record.payload.report?.trim()) return record.payload.report.trim();
	if (record.payload.error?.trim()) return record.payload.error.trim();
	if (record.payload.interruptionReason?.trim()) return record.payload.interruptionReason.trim();
	return `Subagent ${record.status}`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeXmlWithinBytes(value: string, maximumBytes: number): string {
	let byteLength = 0;
	const escaped: string[] = [];
	for (const character of value) {
		const fragment = escapeXml(character);
		const fragmentBytes = Buffer.byteLength(fragment, "utf8");
		if (byteLength + fragmentBytes > maximumBytes) break;
		escaped.push(fragment);
		byteLength += fragmentBytes;
	}
	return escaped.join("");
}
