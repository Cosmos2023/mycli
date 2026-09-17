import type { CanonicalConversationItem, CanonicalToolCall, ToolDefinition } from "@mycli/core";
import { modelInputSha256 } from "@mycli/core";
import { isRecord } from "./redaction.ts";
import type { TrainingRedactor } from "./redaction.ts";
import { trainingReasoning } from "./reasoning.ts";
import type { TrainingMessage, TrainingToolCall, TrainingToolDefinition } from "./types.ts";

/** Project each actual conversation item once, preserving failed and incomplete tool interactions. */
export class TrainingMessageProjector {
	readonly #redactor: TrainingRedactor;
	readonly #callIds = new Map<string, string>();
	readonly #contexts = new Map<string, string>();

	constructor(redactor: TrainingRedactor) { this.#redactor = redactor; }

	context(key: string, role: "developer" | "user", text: string): TrainingMessage | undefined {
		const hash = modelInputSha256({ role, text });
		if (this.#contexts.get(key) === hash) return undefined;
		this.#contexts.set(key, hash);
		return { role, content: this.#redactor.text(text) };
	}

	removeContext(key: string): void { this.#contexts.delete(key); }

	item(item: CanonicalConversationItem, turnId: string): TrainingMessage | undefined {
		switch (item.type) {
			case "user": return { role: "user", content: this.#redactor.text(item.text), ...(item.images?.length ? { images: item.images } : {}) };
			case "context":
				if (item.metadata.tombstone) { this.removeContext(item.metadata.sourceId); return undefined; }
				return this.context(item.metadata.sourceId, item.metadata.role ?? "user", item.text);
			case "assistant": case "assistant_tool_calls": {
				const reasoning = trainingReasoning(item.providerState, this.#redactor);
				const native = item.providerState?.value.responsesNativeItems;
				const activity = Array.isArray(native) ? native.filter((entry) => isRecord(entry) && entry.type === "web_search_call") : [];
				return { role: "assistant", content: this.#redactor.text(item.text),
					...(reasoning.length ? { reasoning } : {}),
					...(activity.length ? { native_activity: activity.map((entry) => {
						const redacted = this.#redactor.json(entry);
						if (!isRecord(redacted)) throw new TypeError("Expected stored native activity");
						return redacted;
					}) } : {}),
					...(item.type === "assistant_tool_calls" ? { tool_calls: item.calls.map((call) => this.#call(call, turnId)) } : {}),
				};
			}
			case "tool_result": return { role: "tool", tool_call_id: this.#callId(item.callId, turnId), content: this.#redactor.text(item.output),
				...(!item.success ? { is_error: true as const } : {}), ...(item.images?.length ? { images: item.images } : {}) };
		}
	}

	#callId(original: string, turnId: string): string {
		const key = JSON.stringify([turnId, original]);
		let id = this.#callIds.get(key);
		if (!id) { id = `call_${this.#callIds.size + 1}`; this.#callIds.set(key, id); }
		return id;
	}

	#call(call: CanonicalToolCall, turnId: string): TrainingToolCall {
		let args: string;
		try { args = JSON.stringify(this.#redactor.json(JSON.parse(call.argumentsJson))); }
		catch { args = this.#redactor.text(call.argumentsJson); }
		return { id: this.#callId(call.callId, turnId), type: "function", function: { name: this.#redactor.text(call.name), arguments: args } };
	}
}

export function trainingToolDefinition(tool: ToolDefinition, redactor: TrainingRedactor): TrainingToolDefinition {
	return { type: "function", function: { name: redactor.text(tool.name), description: redactor.text(tool.description), parameters: redactor.schema(tool.inputSchema) } };
}
