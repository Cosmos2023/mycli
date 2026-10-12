import { Input, getKeybindings, type Component, type Focusable } from "../../tui-core/index.ts";
import type { MycliShellWorktree } from "../../model.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints, nextDecisionIndex, type DecisionItem } from "./decision-list.ts";

const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

type WorktreeStage =
	| { readonly kind: "menu" }
	| { readonly kind: "name" }
	| { readonly kind: "browse" }
	| { readonly kind: "actions"; readonly worktree: MycliShellWorktree };

/**
 * Codex-shaped `/worktree`: create an isolated checkout, or reopen one that already exists.
 * The component owns navigation only; every git side effect stays behind the caller's callbacks.
 */
export class WorktreeSelectorComponent implements Component, Focusable {
	private readonly panel: DecisionPanel;
	private readonly input = new Input();
	private readonly controller = new AbortController();
	private stage: WorktreeStage = { kind: "menu" };
	private index = 0;
	private worktrees: readonly MycliShellWorktree[] = [];
	private loading = true;
	private busy = false;
	private status = "";
	private error = "";

	constructor(private readonly options: DecisionPanelOptions & {
		readonly onLoad: () => Promise<readonly MycliShellWorktree[]>;
		readonly onStart: (request: { readonly name?: string; readonly path?: string }) => Promise<void>;
		readonly onResume: (sessionId: string) => Promise<void>;
		readonly onRemove: (path: string) => Promise<void>;
		readonly onCancel: () => void;
	}) {
		this.panel = new DecisionPanel(options);
		this.update();
		void this.load();
	}

	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }
	invalidate(): void { this.panel.invalidate(); }
	render(width: number): string[] { return this.panel.render(width); }
	dispose(): void { this.controller.abort(); }

	handleInput(data: string): void {
		if (this.controller.signal.aborted || this.panel.handleInput(data)) return;
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.stage.kind === "menu") { this.dispose(); this.options.onCancel(); return; }
			this.returnToMenu();
			return;
		}
		if (this.busy || this.loading) return;
		if (this.stage.kind === "name") {
			if (keys.matches(data, "tui.select.confirm")) {
				void this.confirm();
				return;
			}
			this.input.handleInput(data);
		} else if (keys.matches(data, "tui.select.up")) {
			this.index = nextDecisionIndex(this.items(), this.index, -1);
		} else if (keys.matches(data, "tui.select.down")) {
			this.index = nextDecisionIndex(this.items(), this.index, 1);
		} else if (keys.matches(data, "tui.select.confirm")) {
			void this.confirm();
			return;
		}
		this.update();
	}

	private async load(): Promise<void> {
		try {
			const worktrees = await this.options.onLoad();
			if (this.controller.signal.aborted) return;
			this.worktrees = worktrees;
		} catch (caught) {
			if (this.controller.signal.aborted) return;
			this.error = safeErrorMessage(caught, "Unable to list managed worktrees.");
		} finally {
			if (!this.controller.signal.aborted) {
				this.loading = false;
				this.update();
			}
		}
	}

	private returnToMenu(): void {
		this.stage = { kind: "menu" };
		this.index = 0;
		this.input.setValue("");
		this.status = "";
		this.error = "";
		this.update();
	}

	private items(): readonly DecisionItem[] {
		switch (this.stage.kind) {
			case "menu":
				return [
					{
						label: "New worktree",
						description: "Create an isolated checkout and start a conversation there",
					},
					{
						label: "Browse worktrees",
						description: this.worktrees.length === 0
							? "No managed worktrees in this repository yet"
							: `${this.worktrees.length} managed checkout${this.worktrees.length === 1 ? "" : "s"}`,
					},
				];
			case "browse":
				return this.worktrees.length === 0
					? [{ label: "No worktrees yet", description: "Create one with New worktree", disabled: true }]
					: this.worktrees.map((worktree) => ({
						label: worktree.sessionTitle ?? worktree.name,
						description: describeWorktree(worktree),
						current: worktree.current,
					}));
			case "actions": {
				const { worktree } = this.stage;
				return [
					...(worktree.sessionId
						? [{
							label: "Resume session in this worktree",
							description: worktree.sessionTitle ?? worktree.sessionId,
						}]
						: []),
					{
						label: "Start a new session here",
						description: worktree.path,
					},
					{
						label: "Delete worktree",
						description: "Keeps the branch; refuses when the checkout has local changes",
						...(worktree.current
							? { disabledReason: "Switch to another checkout before deleting this one" }
							: {}),
					},
				];
			}
			case "name":
				return [];
		}
	}

	private async confirm(): Promise<void> {
		if (this.stage.kind !== "name") {
			const item = this.items()[this.index];
			if (!item || item.disabled || item.disabledReason) return;
		}
		if (this.stage.kind === "menu") {
			if (this.index === 0) {
				this.stage = { kind: "name" };
				this.index = 0;
				this.status = "";
				this.update();
				return;
			}
			this.stage = { kind: "browse" };
			this.index = 0;
			this.update();
			return;
		}
		if (this.stage.kind === "name") {
			const name = this.input.getValue().trim();
			if (name && !WORKTREE_NAME.test(name)) {
				this.status = "Use letters, digits, '.', '_' or '-'.";
				this.update();
				return;
			}
			await this.run(() => this.options.onStart(name ? { name } : {}), "Creating worktree…");
			return;
		}
		if (this.stage.kind === "browse") {
			const worktree = this.worktrees[this.index];
			if (!worktree) return;
			this.stage = { kind: "actions", worktree };
			this.index = 0;
			this.update();
			return;
		}
		const { worktree } = this.stage;
		const hasResume = Boolean(worktree.sessionId);
		if (hasResume && this.index === 0) {
			await this.run(() => this.options.onResume(worktree.sessionId!), "Resuming session…");
			return;
		}
		if (this.index === (hasResume ? 1 : 0)) {
			await this.run(() => this.options.onStart({ path: worktree.path }), "Opening worktree…");
			return;
		}
		await this.run(
			() => this.options.onRemove(worktree.path),
			"Removing worktree…",
			"Worktree removed.",
		);
		if (!this.controller.signal.aborted) await this.load();
	}

	private async run(
		operation: () => Promise<void>,
		pending: string,
		success?: string,
	): Promise<void> {
		this.busy = true;
		this.status = pending;
		this.error = "";
		this.update();
		try {
			await operation();
			if (!this.controller.signal.aborted) {
				if (success) {
					this.status = success;
					this.stage = { kind: "browse" };
					this.index = 0;
				} else {
					// The caller normally closes the picker; leave it in a sane state if it does not.
					this.stage = { kind: "menu" };
					this.index = 0;
					this.input.setValue("");
					this.status = "";
				}
			}
		} catch (caught) {
			if (!this.controller.signal.aborted) {
				this.error = safeErrorMessage(caught, "The worktree command failed.");
				this.status = "";
			}
		} finally {
			if (!this.controller.signal.aborted) {
				this.busy = false;
				this.update();
			}
		}
	}

	private update(): void {
		const browse = this.stage.kind === "browse";
		this.panel.setContent({
			title: this.stage.kind === "menu"
				? "Worktrees"
				: this.stage.kind === "name"
					? "Worktree name"
					: this.stage.kind === "actions"
						? `Worktree · ${this.stage.worktree.name}`
						: "Managed worktrees",
			meta: browse && !this.loading ? `${this.worktrees.length} checkouts` : undefined,
			details: this.stage.kind === "name"
				? ["Leave empty to use a generated name.", "Managed checkouts live under the mycli home, not in the project."]
				: this.stage.kind === "menu"
					? ["A worktree is a second checkout of this repository with its own branch."]
					: undefined,
			preview: this.stage.kind === "name" ? this.input : undefined,
			items: this.items(),
			selectedIndex: this.index,
			busy: this.busy || this.loading,
			status: this.error || this.status,
			tone: this.error ? "warning" : "accent",
			hints: decisionNavigationHints(
				this.stage.kind === "name" ? "create" : "open",
				this.stage.kind === "menu" ? "close" : "back",
			),
		});
	}
}

function describeWorktree(worktree: MycliShellWorktree): string {
	const parts = [worktree.branch ? `branch ${worktree.branch}` : undefined, worktree.path];
	if (worktree.sessionId) parts.push(worktree.sessionTitle ?? `session ${worktree.sessionId}`);
	return parts.filter((part): part is string => Boolean(part)).join(" · ");
}
