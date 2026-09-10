import {
	shellContextActivity,
	toolContextActivity,
	type ContextActivity,
} from "../../transcript/context-activity.ts";
import type { CollapsedToolGroup } from "../../transcript/tool-group.ts";
import { Container } from "../../tui-core/tui.ts";
import { ExplorationSummaryComponent } from "./exploration-summary.ts";

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
	}
}
