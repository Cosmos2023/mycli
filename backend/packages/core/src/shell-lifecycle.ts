export const SHELL_LIFECYCLE_OUTPUT_CHUNK_MAX_CHARS = 16_384;

export type ShellLifecycleKind =
	| "shell.started"
	| "shell.output"
	| "shell.completed"
	| "shell.removed"
	| "shell.list.updated";

export type ShellTransportKind = "pipe" | "unix_pty" | "windows_conpty";

export interface ShellLifecycleEvent {
	readonly type: "shell_lifecycle";
	readonly kind: ShellLifecycleKind;
	readonly shellId: string;
	readonly ownerSessionId: string;
	readonly callId: string | null;
	readonly sequence: number;
	readonly commandPreview: string;
	readonly background: boolean;
	readonly processState: string;
	readonly transport?: ShellTransportKind;
	readonly tty: boolean;
	readonly yielded: boolean;
	readonly terminalState?: string;
	readonly exitCode?: number;
	readonly outputDelta?: string;
	readonly nextCursor?: number;
	readonly outputChars?: number;
	readonly omittedOutputChars?: number;
	readonly cleanupResult?: string;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly activeBackgroundCount?: number;
	readonly shellKind?: string;
	readonly shellEdition?: string;
}
