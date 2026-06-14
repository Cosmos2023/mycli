import { Markdown } from "../tui-core/components/markdown.ts";
import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import { markdownTheme } from "./markdown-theme.ts";
import { theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class AssistantMessageComponent extends Container {
	private text: string;
	private thinking?: string;
	private thinkingHidden: boolean;

	constructor(text: string, thinking?: string, thinkingHidden = true) {
		super();
		this.text = text;
		this.thinking = thinking;
		this.thinkingHidden = thinkingHidden;
		this.rebuild();
	}

	updateMessage(text: string, thinking?: string, thinkingHidden = true): void {
		this.text = text;
		this.thinking = thinking;
		this.thinkingHidden = thinkingHidden;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const hasThinking = Boolean(this.thinking?.trim());
		const hasText = Boolean(this.text.trim());
		if (hasThinking || hasText) {
			this.addChild(new Spacer(1));
		}
		if (hasThinking) {
			this.addChild(
				this.thinkingHidden
					? new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0)
					: new Markdown(this.thinking!.trim(), 1, 0, markdownTheme(), {
							color: (content) => theme.fg("thinkingText", content),
							italic: true,
						}),
			);
			if (hasText) {
				this.addChild(new Spacer(1));
			}
		}
		if (hasText) {
			this.addChild(new Markdown(this.text.trim(), 1, 0, markdownTheme()));
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
