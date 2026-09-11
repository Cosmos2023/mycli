import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ProviderEvent, WebSearchAction } from "@mycli/core";

type WebSearchEvent = Extract<ProviderEvent, { type: "web_search_started" | "web_search_completed" }>;
export type PiAiStreamEvent = AssistantMessageEvent | WebSearchEvent;

interface SearchState {
	action: WebSearchAction;
	finished: boolean;
	emitted: boolean;
}

const MAX_SEARCH_CALLS = 4_096;
const MAX_SEARCH_QUERIES = 32;
const MAX_SEARCH_DETAIL_CHARS = 2_048;

export class PiAiWebSearchStream {
	readonly #calls = new Map<string, SearchState>();
	readonly #stream: ReadableStream<PiAiStreamEvent>;
	#controller!: ReadableStreamDefaultController<PiAiStreamEvent>;
	#closed = false;

	constructor() {
		this.#stream = new ReadableStream<PiAiStreamEvent>({
			start: (controller) => { this.#controller = controller; },
		}, { highWaterMark: 0 });
	}

	observe(event: Readonly<Record<string, unknown>>): void {
		if (this.#closed) return;
		switch (event.type) {
			case "response.web_search_call.in_progress":
			case "response.web_search_call.searching":
				this.#start(event.item_id);
				break;
			case "response.web_search_call.completed": {
				const state = this.#start(event.item_id);
				if (state) state.finished = true;
				break;
			}
			case "response.output_item.added":
			case "response.output_item.done":
				this.#item(event.item, event.type === "response.output_item.done");
				break;
			case "response.completed":
				if (!isRecord(event.response)) break;
				if (Array.isArray(event.response.output)) {
					for (const item of event.response.output) this.#item(item, true);
				}
				for (const [id, state] of this.#calls) {
					if (state.finished) this.#complete(id, state);
				}
				break;
		}
	}

	async *merge(source: AsyncIterable<AssistantMessageEvent>, signal: AbortSignal): AsyncGenerator<PiAiStreamEvent> {
		const iterator = source[Symbol.asyncIterator]();
		const reader = this.#stream.getReader();
		let failure: { error: unknown } | undefined;
		const cancel = (): void => {
			this.#closed = true;
			void reader.cancel(signal.reason).catch(() => undefined);
		};
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		// Drain SDK events promptly so slow consumers cannot reorder them behind native activities.
		const producer = (async (): Promise<void> => {
			try {
				while (!this.#closed) {
					const result = await iterator.next();
					if (result.done) break;
					this.#push(result.value);
					if (result.value.type === "done" || result.value.type === "error") break;
				}
			} catch (error) {
				failure = { error };
			} finally {
				if (!this.#closed) this.#controller.close();
				this.#closed = true;
			}
		})();
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				yield result.value;
			}
			if (failure) throw failure.error;
		} finally {
			this.#closed = true;
			signal.removeEventListener("abort", cancel);
			await reader.cancel();
			reader.releaseLock();
			await producer;
			try { await iterator.return?.(); } catch { /* The provider owns upstream cancellation. */ }
			this.#calls.clear();
		}
	}

	#item(value: unknown, done: boolean): void {
		if (!isRecord(value) || value.type !== "web_search_call" || typeof value.id !== "string") return;
		const state = this.#start(value.id);
		if (!state) return;
		if (isRecord(value.action)) state.action = searchAction(value.action);
		if (value.status === "completed" || (done && value.status === undefined)) {
			this.#complete(value.id, state);
		}
	}

	#start(value: unknown): SearchState | undefined {
		if (typeof value !== "string" || !value.trim() || value.length > 256) return undefined;
		const existing = this.#calls.get(value);
		if (existing) return existing;
		if (this.#calls.size >= MAX_SEARCH_CALLS) return undefined;
		const state: SearchState = { action: { type: "other" }, finished: false, emitted: false };
		this.#calls.set(value, state);
		this.#push({ type: "web_search_started", callId: value });
		return state;
	}

	#complete(callId: string, state: SearchState): void {
		if (state.emitted) return;
		state.finished = true;
		state.emitted = true;
		this.#push({ type: "web_search_completed", call: { callId, action: state.action } });
	}

	#push(event: PiAiStreamEvent): void {
		if (!this.#closed) this.#controller.enqueue(event);
	}
}

function searchAction(action: Readonly<Record<string, unknown>>): WebSearchAction {
	switch (action.type) {
		case "search": {
			const query = detail(action.query);
			const queries = Array.isArray(action.queries)
				? action.queries.slice(0, MAX_SEARCH_QUERIES).map(detail).filter((value): value is string => value !== undefined)
				: undefined;
			return { type: "search", ...(query === undefined ? {} : { query }), ...(queries ? { queries } : {}) };
		}
		case "open_page": {
			const url = detail(action.url);
			return { type: "open_page", ...(url === undefined ? {} : { url }) };
		}
		case "find_in_page": {
			const url = detail(action.url);
			const pattern = detail(action.pattern);
			return { type: "find_in_page", ...(url === undefined ? {} : { url }), ...(pattern === undefined ? {} : { pattern }) };
		}
		default:
			return { type: "other" };
	}
}

function detail(value: unknown): string | undefined {
	return typeof value === "string" ? value.slice(0, MAX_SEARCH_DETAIL_CHARS) : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
