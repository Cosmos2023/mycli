import {
	shellContextActivity,
	toolContextActivity,
	type ContextActivity,
} from "../../transcript/context-activity.ts";
import type { CollapsedToolGroup } from "../../transcript/tool-group.ts";
import { Text } from "../../tui-core/components/text.ts";
import { Container } from "../../tui-core/tui.ts";
import { theme } from "../../theme/theme.ts";
import { keyHint } from "../shared/keybinding-hints.ts";
import { ExplorationSummaryComponent } from "./exploration-summary.ts";
import { TRANSCRIPT_DETAIL_INDENT } from "./transcript-gutter.ts";

/** Expanded runs are split into individual records by transcript-projection. */
export class CollapsedToolGroupComponent extends Container {
	constructor(group: CollapsedToolGroup) {
		super();
		this.updateGroup(group);
	}

	updateGroup(group: CollapsedToolGroup): void {
		this.clear();
		const activities = group.items
			.map((item) => item.kind === "tool" ? toolContextActivity(item.tool) : shellContextActivity(item.bash))
			.filter((activity): activity is ContextActivity => activity !== undefined);
		this.addChild(new ExplorationSummaryComponent(activities));
		this.addChild(new Text(
			theme.fg("muted", `+ Show details (${keyHint("app.tools.expand", "expand")})`),
			TRANSCRIPT_DETAIL_INDENT,
			0,
		));
	}

	/** True when the given rendered row is this group's collapsed expand affordance. */
	isDetailsToggleRow(row: number, width: number): boolean {
		return row === this.render(width).length - 1;
	}
}
