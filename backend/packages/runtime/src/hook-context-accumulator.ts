import { modelInputSha256 } from "@mycli/core";
import type {
	RuntimeHookContext,
	RuntimeHookPoint,
} from "./instruction-context.ts";

export interface AppendHookContextsInput {
	readonly point: RuntimeHookPoint;
	readonly contexts: readonly string[];
	readonly source?: string;
	readonly trusted?: boolean;
	readonly policyProducing?: boolean;
}

export class HookContextAccumulator {
	readonly #contexts = new Map<string, RuntimeHookContext>();

	append(input: AppendHookContextsInput): void {
		for (const raw of input.contexts) {
			const content = raw.trim();
			if (!content) continue;
			const context = Object.freeze({
				point: input.point,
				content,
				source: input.source ?? `hook:${input.point}`,
				trusted: input.trusted ?? false,
				policyProducing: input.policyProducing ?? false,
			});
			this.#contexts.set(modelInputSha256(context), context);
		}
	}

	snapshot(): readonly RuntimeHookContext[] {
		return Object.freeze([...this.#contexts.values()]);
	}
}
