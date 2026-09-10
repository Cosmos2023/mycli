const DEFAULT_TRANSCRIPT_REPLAY_MAX_ROWS = 1_000;
const VSCODE_TRANSCRIPT_REPLAY_MAX_ROWS = 1_000;
const WINDOWS_TERMINAL_TRANSCRIPT_REPLAY_MAX_ROWS = 9_001;
const WEZTERM_TRANSCRIPT_REPLAY_MAX_ROWS = 3_500;
const ALACRITTY_TRANSCRIPT_REPLAY_MAX_ROWS = 10_000;

export function resolveTranscriptReplayMaxRows(
	env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
	const configured = env.MYCLI_TUI_TRANSCRIPT_REPLAY_MAX_ROWS?.trim();
	if (configured) {
		const value = Number.parseInt(configured, 10);
		if (Number.isInteger(value) && value >= 0) {
			return value === 0 ? undefined : value;
		}
	}

	if (env.WT_SESSION) return WINDOWS_TERMINAL_TRANSCRIPT_REPLAY_MAX_ROWS;
	const termProgram = env.TERM_PROGRAM?.trim().toLowerCase() ?? "";
	if (termProgram === "vscode") return VSCODE_TRANSCRIPT_REPLAY_MAX_ROWS;
	if (termProgram === "wezterm") return WEZTERM_TRANSCRIPT_REPLAY_MAX_ROWS;
	if (termProgram === "alacritty") return ALACRITTY_TRANSCRIPT_REPLAY_MAX_ROWS;
	return DEFAULT_TRANSCRIPT_REPLAY_MAX_ROWS;
}
