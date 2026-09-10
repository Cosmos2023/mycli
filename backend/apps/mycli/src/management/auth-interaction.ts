import { createInterface } from "node:readline/promises";
import { Writable, type Readable } from "node:stream";
import type { NativeAuthEvent, NativeAuthInteraction, NativeAuthPrompt } from "@mycli/providers";

export interface AuthInteractionInput extends NodeJS.ReadableStream {
	readonly isTTY?: boolean;
}

export function createNativeAuthInteraction(options: {
	readonly input: AuthInteractionInput;
	readonly output: { write(value: string): unknown };
	readonly signal: AbortSignal;
}): NativeAuthInteraction {
	if (!options.input.isTTY) throw new Error("auth_interactive_required");
	return {
		prompt: async (prompt) => ask(prompt, options),
		notify: (event) => {
			if (!options.signal.aborted) options.output.write(`${eventText(event)}\n`);
		},
	};
}

async function ask(prompt: NativeAuthPrompt, options: {
	readonly input: AuthInteractionInput;
	readonly output: { write(value: string): unknown };
	readonly signal: AbortSignal;
}): Promise<string> {
	const cancelled = new AbortController();
	const signal = AbortSignal.any([options.signal, cancelled.signal, ...(prompt.signal ? [prompt.signal] : [])]);
	signal.throwIfAborted();
	const hidden = prompt.type === "secret" || prompt.type === "manual_code";
	const output = new Writable({
		write(chunk: Buffer, _encoding, done): void {
			if (!hidden) options.output.write(chunk.toString("utf8"));
			done();
		},
	});
	const rl = createInterface({ input: options.input as Readable, output, terminal: true, historySize: 0 });
	rl.once("SIGINT", () => cancelled.abort(new DOMException("Login interrupted", "AbortError")));
	rl.once("close", () => cancelled.abort(new DOMException("Login input closed", "AbortError")));
	try {
		options.output.write(`${prompt.message}\n`);
		if (prompt.type === "select") prompt.options.forEach((option, index) => options.output.write(`${index + 1}. ${option.label}\n`));
		const answer = (await rl.question(hidden ? "" : "> ", { signal })).trim();
		if (answer.length > 16 * 1024) throw new Error("auth_input_too_large");
		if (prompt.type !== "select") return answer;
		const selected = prompt.options.find((option) => option.id === answer)
			?? prompt.options[Number(answer || "1") - 1];
		if (!selected) throw new Error("auth_selection_invalid");
		return selected.id;
	} finally {
		rl.close();
		output.destroy();
		if (hidden) options.output.write("\n");
	}
}

function eventText(event: NativeAuthEvent): string {
	if (event.type === "auth_url") return [event.instructions, event.url].filter(Boolean).join("\n");
	if (event.type === "device_code") return `${event.verificationUri}\nCode: ${event.userCode}`;
	return [event.message, ...(event.links ?? []).map((link) => link.label ? `${link.label}: ${link.url}` : link.url)].join("\n");
}
