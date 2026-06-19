import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellCommandDiagnostic, MycliShellDiagnosticMetric } from "../model.ts";
import type { ThemeColor } from "../theme/theme.ts";
import { theme } from "../theme/theme.ts";

export class CommandDiagnosticComponent extends Container {
	private diagnostic: MycliShellCommandDiagnostic;

	constructor(diagnostic: MycliShellCommandDiagnostic) {
		super();
		this.diagnostic = diagnostic;
		this.rebuild();
	}

	updateDiagnostic(diagnostic: MycliShellCommandDiagnostic): void {
		this.diagnostic = diagnostic;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.headerText(), 1, 0));
		if (this.diagnostic.metrics.length > 0) {
			this.addChild(new Text(this.metricLine(this.diagnostic.metrics), 3, 0));
		}
		for (const section of this.diagnostic.sections) {
			this.addChild(new Text(theme.fg("muted", section.title), 3, 0));
			for (const row of section.rows) {
				this.addChild(new Text(this.rowLine(row), 5, 0));
			}
		}
	}

	private headerText(): string {
		const icon = this.diagnostic.kind === "context" ? "CTX" : this.diagnostic.kind === "usage" ? "USE" : "CMD";
		return `${theme.fg("accent", theme.bold(icon))} ${theme.fg("accent", theme.bold(this.diagnostic.title))} ${theme.fg("dim", this.diagnostic.command)}`;
	}

	private metricLine(metrics: MycliShellDiagnosticMetric[]): string {
		return metrics
			.map((metric) => `${theme.fg("dim", `${metric.label}:`)} ${theme.fg(this.color(metric), metric.value)}`)
			.join(theme.fg("dim", "  ·  "));
	}

	private rowLine(metric: MycliShellDiagnosticMetric): string {
		return `${theme.fg("dim", ">")} ${theme.fg("muted", `${metric.label}:`)} ${theme.fg(this.color(metric), metric.value)}`;
	}

	private color(metric: MycliShellDiagnosticMetric): ThemeColor {
		return metric.accent ?? "text";
	}
}
