/** Coalesce local terminal notifications, without including conversation contents. */
export class TerminalAttention {
	private focused = true;
	private enabled = true;
	private pending: { message: string; priority: number } | null = null;
	private timer: NodeJS.Timeout | null = null;

	constructor(private readonly write: (sequence: string) => void) {}

	configure(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.clear();
	}

	handleInput(data: string): boolean {
		if (data !== "\x1b[I" && data !== "\x1b[O") return false;
		this.focused = data === "\x1b[I";
		if (this.focused) this.clear();
		return true;
	}

	notify(message: "Approval required" | "Answer required" | "Plan ready" | "Turn completed", priority: number): void {
		if (this.focused || !this.enabled) return;
		if (!this.pending || priority > this.pending.priority) this.pending = { message, priority };
		if (this.timer) return;
		this.timer = setTimeout(() => {
			const pending = this.pending;
			this.clear();
			if (pending && !this.focused && this.enabled) this.write(`\x1b]9;mycli: ${pending.message}\x07`);
		}, 150);
		this.timer.unref();
	}

	clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.pending = null;
	}
}
