import type { MarkdownTheme } from "../../tui-core/components/markdown.ts";
import { getMarkdownTheme } from "../../theme/theme.ts";

export function markdownTheme(): MarkdownTheme {
	return getMarkdownTheme();
}
