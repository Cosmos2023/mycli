export type ShellTransportKind = "pipe" | "unix_pty" | "windows_conpty";
export type ShellStream = "stdout" | "stderr" | "terminal";

export interface ShellOutputChunk {
	readonly sequence: number;
	readonly stream: ShellStream;
	readonly data: Uint8Array | string;
}

export interface ShellExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
}

export type ProcessCleanupState =
	| "interrupted"
	| "terminated"
	| "already_exited"
	| "inconclusive";

export interface ProcessCleanupResult {
	readonly state: ProcessCleanupState;
	readonly exitCode?: number;
	readonly signal?: string;
}

export interface ShellTransport {
	readonly kind: ShellTransportKind;
	readonly tty: boolean;
	readonly pid: number;
	onOutput(listener: (chunk: ShellOutputChunk) => void): () => void;
	onExit(listener: (exit: ShellExit) => void): () => void;
	write(text: string): Promise<void>;
	resize(rows: number, columns: number): Promise<void>;
	interrupt(): Promise<ProcessCleanupResult>;
	terminate(): Promise<ProcessCleanupResult>;
	close(): Promise<void>;
}

export interface ShellTransportStartRequest {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly platform: NodeJS.Platform;
	readonly tty: boolean;
	readonly rows: number;
	readonly columns: number;
}

export type ShellTransportFactory = (
	request: ShellTransportStartRequest,
) => Promise<ShellTransport>;

export type ShellTransportErrorKind =
	| "stdin_closed"
	| "shell_write_failed"
	| "shell_resize_failed"
	| "shell_cleanup_failed";

export class ShellTransportError extends Error {
	constructor(
		readonly kind: ShellTransportErrorKind,
		message: string,
	) {
		super(message);
		this.name = "ShellTransportError";
	}
}
