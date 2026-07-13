import { spawnSync as nodeSpawnSync } from "node:child_process";

type ClipboardSpawn = (
	command: string,
	args?: readonly string[],
	options?: { input?: string; stdio?: ["pipe", "ignore", "ignore"] },
) => { status: number | null };

type ClipboardOptions = {
	platform?: NodeJS.Platform;
	spawnSync?: ClipboardSpawn;
};

type ClipboardCommand = {
	command: string;
	args: readonly string[];
};

export function copyText(text: string, options: ClipboardOptions = {}): boolean {
	const commands = clipboardCommands(options.platform ?? process.platform);
	const spawn = options.spawnSync ?? defaultSpawn;
	for (const candidate of commands) {
		try {
			const result = spawn(candidate.command, candidate.args, {
				input: text,
				stdio: ["pipe", "ignore", "ignore"],
			});
			if (result.status === 0) return true;
		} catch {
			// Missing clipboard commands are expected on minimal systems.
		}
	}
	return false;
}

function clipboardCommands(platform: NodeJS.Platform): readonly ClipboardCommand[] {
	switch (platform) {
		case "darwin":
			return [{ command: "pbcopy", args: [] }];
		case "win32":
			return [{ command: "clip.exe", args: [] }];
		case "linux":
			return [
				{ command: "wl-copy", args: [] },
				{ command: "xclip", args: ["-selection", "clipboard"] },
				{ command: "xsel", args: ["--clipboard", "--input"] },
			];
		default:
			return [];
	}
}

const defaultSpawn: ClipboardSpawn = (command, args = [], options = {}) =>
	nodeSpawnSync(command, [...args], options);
