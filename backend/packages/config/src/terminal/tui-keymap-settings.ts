import { applyUserConfigEdits } from "../configuration/user-config-editor.ts";
import type { ResolveConfigOptions } from "../configuration/settings.ts";

export interface ResetTuiKeymapOptions extends ResolveConfigOptions {
	readonly failpoint?: (name: string) => void;
}

export async function resetTuiKeymap(options: ResetTuiKeymapOptions): Promise<boolean> {
	return applyUserConfigEdits({
		...options,
		edits: [{ action: "clear", path: ["tui", "keymap"] }],
		validateCurrent: true,
		...(options.failpoint ? { failpoint: options.failpoint } : {}),
	});
}
