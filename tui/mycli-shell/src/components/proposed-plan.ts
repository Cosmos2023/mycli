import type { MycliShellPlan } from "../model.ts";
import { Box } from "../tui-core/components/box.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import { theme } from "../theme/theme.ts";

export class ProposedPlanComponent extends Container {
	constructor(private readonly plan: MycliShellPlan) {
		super();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const label = this.plan.status === "accepted" ? "Plan accepted" : this.plan.status === "stale" ? "Plan updated" : "Proposed plan";
		const body = this.plan.text.trim() || "No plan content.";
		const box = new Box(1, 0);
		box.addChild(new Text(theme.fg("accent", theme.bold(`✻ ${label}`)), 0, 0));
		box.addChild(new Text(body, 0, 0));
		this.addChild(box);
	}
}
