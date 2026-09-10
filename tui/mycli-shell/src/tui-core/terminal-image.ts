import { execSync } from "node:child_process";

const IMAGE_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;
const IMAGE_FILE_RE = new RegExp(`\\.(${IMAGE_FILE_EXTENSIONS.join("|")})$`, "i");

export function isImageFilePath(path: string): boolean {
	return IMAGE_FILE_RE.test(path);
}

type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;

/**
 * Checks whether the attached tmux client forwards OSC 8 hyperlinks to the
 * outer terminal. tmux only re-emits them when its `client_termfeatures` lists
 * `hyperlinks`, and strips them otherwise. On any error fallbacks `false`.
 */
function probeTmuxHyperlinks(): boolean {
	try {
		const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return termfeatures
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks");
	} catch {
		return false;
	}
}

function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit";

	// Emit OSC 8 hyperlinks only when tmux confirms it forwards.
	// Image protocols are unreliable under tmux, so leave `images: null`.
	if (process.env.TMUX || term.startsWith("tmux")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: tmuxForwardsHyperlink() };
	}

	// screen does not forward OSC 8 hyperlinks, so keep them off there.
	if (term.startsWith("screen")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (process.env.WT_SESSION) {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "vscode") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "alacritty") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (terminalEmulator === "jetbrains-jediterm") {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		cachedCapabilities = detectCapabilities();
	}
	return cachedCapabilities;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
