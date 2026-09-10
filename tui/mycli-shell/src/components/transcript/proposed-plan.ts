import type { MycliShellPlan } from "../../model.ts";
import { Markdown } from "../../tui-core/components/markdown.ts";
import { Spacer } from "../../tui-core/components/spacer.ts";
import { Text } from "../../tui-core/components/text.ts";
import { Container } from "../../tui-core/tui.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { markdownTheme } from "../shared/markdown-theme.ts";
import { theme } from "../../theme/theme.ts";

export class ProposedPlanComponent extends Container {
	constructor(private readonly plan: MycliShellPlan) {
		super();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const label = this.plan.status === "accepted" ? "Plan accepted" : this.plan.status === "stale" ? "Plan updated" : "Proposed Plan";
		const body = this.plan.text.trim() || "No plan content.";
		this.addChild(new Text(theme.fg("accent", theme.bold(`${uiGlyphs().bullet} ${label}`)), 1, 0));
		this.addChild(new Spacer(1));
		// Keep the proposal body source-backed so it can be reflowed and rendered as Markdown.
		this.addChild(new Markdown(
			body,
			2,
			0,
			markdownTheme(),
			{ bgColor: (content) => theme.bg("userMessageBg", content) },
		));
		this.addChild(new Spacer(1));
	}
}
