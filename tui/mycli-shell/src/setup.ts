import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	SetupWizardComponent,
	type SetupWizardResult,
	type SetupWizardState,
} from "./components/setup-wizard.ts";
import { ProcessTerminal, type Terminal } from "./tui-core/terminal.ts";
import { Container, TUI } from "./tui-core/tui.ts";

export interface RunSetupTuiOptions {
	readonly state: SetupWizardState;
	readonly terminal?: Terminal;
	readonly signal?: AbortSignal;
}

export function runSetupTui(
	options: RunSetupTuiOptions,
): Promise<SetupWizardResult | undefined> {
	return new Promise((resolve) => {
		const ui = new TUI(options.terminal ?? new ProcessTerminal());
		const root = new Container();
		let settled = false;
		const finish = (result: SetupWizardResult | undefined): void => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
			ui.stop();
			resolve(result);
		};
		const onAbort = (): void => finish(undefined);
		const wizard = new SetupWizardComponent({
			tui: ui,
			state: options.state,
			onSubmit: finish,
			onCancel: () => finish(undefined),
		});

		root.addChild(wizard);
		ui.addChild(root);
		ui.setFocus(wizard);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) {
			finish(undefined);
			return;
		}
		ui.start();
	});
}

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

async function runLegacySetupEntrypoint(): Promise<void> {
	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.once("SIGINT", onSigint);
	try {
		const result = await runSetupTui({ state: readSetupState(), signal: controller.signal });
		if (!result) {
			process.exitCode = 130;
			return;
		}
		const resultPath = process.env.MYCLI_SETUP_RESULT_PATH;
		if (resultPath) {
			writeFileSync(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
			if (process.platform !== "win32") chmodSync(resultPath, 0o600);
		}
		process.exitCode = 0;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

const entryPath = process.argv[1];
if (entryPath && isEntrypoint(entryPath)) {
	void runLegacySetupEntrypoint();
}

function isEntrypoint(entryPath: string): boolean {
	try {
		return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}
