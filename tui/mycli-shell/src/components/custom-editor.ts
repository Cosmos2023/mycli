import { Editor, type EditorOptions, type EditorTheme, type KeybindingsManager, type TUI } from "../tui-core/index.ts";
import type { AppKeybinding } from "../keybindings.ts";

export class CustomEditor extends Editor {
	private readonly keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	override handleInput(data: string): void {
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			super.handleInput(data);
			return;
		}

		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
		}

		for (const [action, handler] of this.actionHandlers) {
			if ((action === "app.commandPalette" || action === "app.help") && this.getText().length > 0) {
				continue;
			}
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		super.handleInput(data);
	}
}
