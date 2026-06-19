import * as fs from "node:fs";
import { SetupWizardComponent, type SetupWizardResult, type SetupWizardState } from "./components/setup-wizard.ts";
import { ProcessTerminal } from "./tui-core/terminal.ts";
import { Container, TUI } from "./tui-core/tui.ts";

function readSetupState(): SetupWizardState {
	const raw = process.env.MYCLI_SETUP_STATE;
	if (!raw) return { providers: [] };
	try {
		const parsed = JSON.parse(raw) as SetupWizardState;
		return {
			providers: Array.isArray(parsed.providers) ? parsed.providers : [],
			config_path: typeof parsed.config_path === "string" ? parsed.config_path : undefined,
			auth_path: typeof parsed.auth_path === "string" ? parsed.auth_path : undefined,
		};
	} catch {
		return { providers: [] };
	}
}

function runSetup(): void {
	const ui = new TUI(new ProcessTerminal());
	const root = new Container();
	let settled = false;

	const finish = (code: number, result?: SetupWizardResult): void => {
		if (settled) return;
		settled = true;
		ui.stop();
		if (result) {
			const resultPath = process.env.MYCLI_SETUP_RESULT_PATH;
			if (resultPath) {
				fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`, "utf8");
			}
		}
		process.exitCode = code;
	};

	const wizard = new SetupWizardComponent({
		tui: ui,
		state: readSetupState(),
		onSubmit: (result) => finish(0, result),
		onCancel: () => finish(130),
	});

	root.addChild(wizard);
	ui.addChild(root);
	ui.setFocus(wizard);
	ui.start();

	process.once("SIGINT", () => finish(130));
}

runSetup();
