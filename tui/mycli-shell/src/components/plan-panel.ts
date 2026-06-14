import type { MycliShellPlanStep, MycliShellPlanStepStatus } from "../model.ts";
import { Box } from "../tui-core/components/box.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import { truncateToWidth } from "../tui-core/utils.ts";
import { theme } from "../theme/theme.ts";

export class PlanPanelComponent extends Container {
	constructor(private steps: MycliShellPlanStep[]) {
		super();
		this.rebuild();
	}

	updateSteps(steps: MycliShellPlanStep[]): void {
		this.steps = steps;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (this.steps.length === 0) {
			return;
		}
		const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(this.header(), 0, 0));
		for (const step of this.visibleSteps()) {
			box.addChild(new Text(this.stepLine(step), 0, 0));
			const evidence = this.evidenceLine(step);
			if (evidence) {
				box.addChild(new Text(evidence, 0, 0));
			}
		}
		const next = this.nextLine();
		if (next) {
			box.addChild(new Text(next, 0, 0));
		}
		this.addChild(box);
	}

	private visibleSteps(): MycliShellPlanStep[] {
		const activeIndex = this.activeIndex();
		const steps: MycliShellPlanStep[] = [];
		const previous = this.previousCompletedStep(activeIndex);
		if (previous) {
			steps.push(previous);
		}
		steps.push(this.steps[activeIndex]);
		return steps;
	}

	private header(): string {
		const completed = this.steps.filter((step) => step.status === "completed").length;
		const total = this.steps.length;
		return `${theme.fg("customMessageLabel", theme.bold("[plan]"))} ${theme.fg("muted", `${completed}/${total}`)}`;
	}

	private stepLine(step: MycliShellPlanStep): string {
		return `${this.statusIcon(step.status)} ${this.statusText(step.status, this.compactText(step.text))}`;
	}

	private statusIcon(status: MycliShellPlanStepStatus): string {
		if (status === "completed") return theme.fg("success", "✓");
		if (status === "in_progress") return theme.fg("accent", "●");
		return theme.fg("muted", "○");
	}

	private statusText(status: MycliShellPlanStepStatus, text: string): string {
		if (status === "completed") return theme.fg("muted", text);
		if (status === "in_progress") return theme.fg("text", theme.bold(text));
		return theme.fg("customMessageText", text);
	}

	private evidenceLine(step: MycliShellPlanStep): string | null {
		if (step.status !== "in_progress") return null;
		const evidence = step.evidence?.find((item) => item.trim().length > 0);
		if (!evidence) return null;
		return theme.fg("muted", `  evidence: ${this.compactText(evidence, 80)}`);
	}

	private nextLine(): string | null {
		const activeIndex = this.activeIndex();
		const nextIndex = this.steps.findIndex((step, index) => index > activeIndex && step.status !== "completed");
		if (nextIndex === -1) return null;
		const next = this.steps[nextIndex];
		const remaining = this.steps.slice(nextIndex + 1).filter((step) => step.status !== "completed").length;
		const suffix = remaining > 0 ? ` +${remaining}` : "";
		return theme.fg("muted", `  next: ${this.compactText(next.text, 72)}${suffix}`);
	}

	private activeIndex(): number {
		const inProgress = this.steps.findIndex((step) => step.status === "in_progress");
		if (inProgress !== -1) return inProgress;
		const pending = this.steps.findIndex((step) => step.status === "pending");
		if (pending !== -1) return pending;
		return Math.max(0, this.steps.length - 1);
	}

	private previousCompletedStep(activeIndex: number): MycliShellPlanStep | null {
		for (let index = activeIndex - 1; index >= 0; index--) {
			if (this.steps[index].status === "completed") {
				return this.steps[index];
			}
		}
		return null;
	}

	private compactText(text: string, width = 84): string {
		return truncateToWidth(text.replace(/\s+/g, " ").trim(), width, "...");
	}
}
