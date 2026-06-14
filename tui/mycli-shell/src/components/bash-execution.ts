import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellBash } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const PREVIEW_LINES = 12;

export class BashExecutionComponent extends Container {
	private bash: MycliShellBash;

	constructor(bash: MycliShellBash) {
		super();
		this.bash = bash;
		this.rebuild();
	}

	updateBash(bash: MycliShellBash): void {
		this.bash = bash;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((text) => theme.fg("bashMode", text)));
		this.addChild(new Text(theme.fg("bashMode", theme.bold(`$ ${this.bash.command}`)), 1, 0));
		if (this.bash.outputPreview) {
			this.addChild(this.outputComponent());
		}
		this.addChild(new Text(this.statusLine(), 1, 0));
		this.addChild(new DynamicBorder((text) => theme.fg("bashMode", text)));
	}

	private outputComponent(): Text | { render: (width: number) => string[]; invalidate: () => void } {
		if (!this.bash.outputPreview) {
			return new Text("", 1, 0);
		}
		if (this.bash.expanded) {
			return new Text(theme.fg("muted", this.bash.outputPreview), 1, 0);
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				if (cachedWidth !== width || !cachedLines) {
					const result = truncateToVisualLines(theme.fg("muted", this.bash.outputPreview ?? ""), PREVIEW_LINES, width, 1);
					cachedLines = result.visualLines;
					cachedWidth = width;
				}
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	}

	private statusLine(): string {
		if (this.bash.status === "running") {
			return theme.fg("muted", `Running... (${keyHint("app.interrupt", "to cancel")})`);
		}
		const status =
			this.bash.status === "error" && this.bash.exitCode !== undefined
				? `exit ${this.bash.exitCode}`
				: this.bash.status;
		const hidden = this.bash.hiddenLineCount
			? this.bash.expanded
				? ` · ${keyHint("app.tools.expand", "collapse")}`
				: ` · ${this.bash.hiddenLineCount} more lines (${keyHint("app.tools.expand", "expand")})`
			: "";
		return theme.fg(this.bash.status === "error" ? "error" : "muted", `(${status})${hidden}`);
	}
}
