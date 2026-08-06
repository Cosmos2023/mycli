import { TruncatedText } from "../tui-core/components/truncated-text.ts";
import { fuzzyFilter } from "../tui-core/fuzzy.ts";
import { Container } from "../tui-core/tui.ts";
import { theme } from "../theme/theme.ts";

type ProviderItem = { id: string; name: string; configured?: boolean };

export class ProviderList<T extends ProviderItem> extends Container {
	private items: readonly T[];
	private selectedIndex = 0;

	constructor(
		private readonly providers: readonly T[],
		private readonly options: {
			emptyMessage: string;
			detail?: (provider: T) => string;
			showPosition?: boolean;
		},
	) {
		super();
		this.items = providers;
		this.rebuild();
	}

	filter(query: string): void {
		this.items = query
			? fuzzyFilter([...this.providers], query, (provider) => `${provider.name} ${provider.id}`)
			: this.providers;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.items.length - 1)));
		this.rebuild();
	}

	move(offset: number): void {
		if (this.items.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + offset));
		this.rebuild();
	}

	current(): T | undefined {
		return this.items[this.selectedIndex];
	}

	private rebuild(): void {
		this.clear();
		const maxVisible = 8;
		const start = Math.max(0, Math.min(this.selectedIndex - 4, this.items.length - maxVisible));
		const end = Math.min(start + maxVisible, this.items.length);
		for (let index = start; index < end; index += 1) {
			const provider = this.items[index];
			if (!provider) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const name = theme.fg(selected ? "accent" : "text", provider.name);
			const status = provider.configured
				? theme.fg("success", " ✓ configured")
				: theme.fg("muted", " • unconfigured");
			this.addChild(new TruncatedText(prefix + name + status + (this.options.detail?.(provider) ?? ""), 1, 0));
		}
		if (this.options.showPosition && (start > 0 || end < this.items.length)) {
			this.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.items.length})`), 1, 0),
			);
		}
		if (this.items.length === 0) {
			this.addChild(new TruncatedText(theme.fg("muted", `  ${this.options.emptyMessage}`), 1, 0));
		}
	}
}
