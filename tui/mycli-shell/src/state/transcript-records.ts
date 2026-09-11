import { parseGatewayToolRecord, projectGatewayToolRecord, type GatewayToolRecord } from "@mycli/contracts";
import type { MycliShellBackgroundProcess, MycliShellBackgroundTerminals } from "../model.ts";
import { recordValue, stringArrayValue, stringValue } from "./payload-values.ts";
import type { RuntimeTranscriptItem } from "./runtime-state-model.ts";

export function upsertTranscriptItem(
	items: RuntimeTranscriptItem[],
	item: RuntimeTranscriptItem,
): RuntimeTranscriptItem[] {
	const index = items.findIndex((existing) => existing.id === item.id);
	if (index < 0) return [...items, item];
	const updated = [...items];
	updated[index] = item;
	return updated;
}

export function backgroundTerminalsFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellBackgroundTerminals | null {
	const metadata = recordValue(item.metadata);
	const value = recordValue(metadata.backgroundTerminals ?? metadata.background_terminals);
	return {
		id: item.id,
		processes: backgroundProcessesFromUnknown(value.processes),
	};
}

export function backgroundProcessesFromUnknown(value: unknown): MycliShellBackgroundProcess[] {
	if (!Array.isArray(value)) return [];
	return value.map(backgroundProcessFromUnknown).filter((process): process is MycliShellBackgroundProcess => process !== null);
}

function backgroundProcessFromUnknown(value: unknown): MycliShellBackgroundProcess | null {
	const record = recordValue(value);
	const shellId = stringValue(record.shell_id) ?? stringValue(record.shellId);
	if (!shellId) return null;
	const output = stringValue(record.output) ?? "";
	const recentOutput = stringArrayValue(record.recentOutput ?? record.recent_output);
	return {
		shellId,
		commandPreview: stringValue(record.command_preview) ?? stringValue(record.commandPreview) ?? "command",
		recentOutput: (recentOutput.length > 0 ? recentOutput : output.split(/\r?\n/))
			.map((line) => line.replace(/[\r\n\t]/g, " ").trim())
			.filter(Boolean)
			.slice(-3)
			.map((line) => line.slice(0, 500)),
	};
}

export function toolRecordFromTranscriptItem(item: RuntimeTranscriptItem): GatewayToolRecord {
	return item.tool_record === undefined
		? projectGatewayToolRecord({ text: item.text, metadata: recordValue(item.metadata) })
		: parseGatewayToolRecord(item.tool_record);
}

export function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (predicate(items[index]!)) {
			return index;
		}
	}
	return -1;
}

export function findToolIndex(items: RuntimeTranscriptItem[], metadata: Record<string, unknown>): number {
	const toolId = stringValue(metadata.tool_id);
	const callId = stringValue(recordValue(metadata.tool_record).call_id) ?? stringValue(metadata.call_id);
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.type !== "tool_summary") continue;
		const itemMetadata = recordValue(item.metadata);
		const itemCallId = item.tool_record ? item.tool_record.call_id : stringValue(itemMetadata.call_id);
		if (callId && itemCallId) {
			if (itemCallId === callId) return index;
			continue;
		}
		if (toolId && stringValue(itemMetadata.tool_id) === toolId) return index;
	}
	return -1;
}

export function isTranscriptItem(value: unknown): value is RuntimeTranscriptItem {
	const record = recordValue(value);
	return Boolean(stringValue(record.id) && stringValue(record.type) && typeof record.text === "string");
}
