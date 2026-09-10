import { Container } from "../../tui-core/tui.ts";
import type { MycliShellCommandDiagnostic, MycliShellCommandResult } from "../../model.ts";
import { CommandResultComponent } from "./command-result.ts";

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
		this.addChild(new CommandResultComponent(this.commandResult()));
	}

	private commandResult(): MycliShellCommandResult {
		return {
			id: this.diagnostic.id,
			display: {
				version: 1,
				kind: "diagnostic",
				command: this.diagnostic.command,
				title: this.diagnostic.title,
				severity: "info",
				fields: this.diagnostic.metrics.map((metric) => ({
					label: metric.label,
					value: metric.value,
					...(metric.accent ? { tone: metric.accent } : {}),
				})),
				rows: [],
				sections: this.diagnostic.sections.map((section) => ({
					title: section.title,
					fields: section.rows.map((row) => ({
						label: row.label,
						value: row.value,
						...(row.accent ? { tone: row.accent } : {}),
					})),
					rows: [],
				})),
				suggestions: [],
				omittedRows: 0,
				omittedChars: 0,
			},
			fallbackLines: this.diagnostic.rawLines ?? [],
			folded: false,
		};
	}
}
