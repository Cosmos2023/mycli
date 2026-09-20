import type * as PiAiModule from "@earendil-works/pi-ai";

export type PiAiRoot = typeof PiAiModule;

let piAiRoot: Promise<PiAiRoot> | undefined;

/**
 * The pi-ai root entry re-exports its model catalog, auth helpers and typebox
 * schemas, which pulled roughly 660 unrelated modules into every backend start.
 * Callers load it on first use instead.
 */
export function loadPiAiRoot(): Promise<PiAiRoot> {
	return piAiRoot ??= import("@earendil-works/pi-ai");
}
