import {
	highlight,
	supportsLanguage,
	type Theme as CliHighlightTheme,
} from "cli-highlight";

import { theme } from "../../theme/theme.ts";


const MAX_HIGHLIGHT_LINES = 2_000;


export function highlightDiffCode(
	code: string,
	language: string | undefined,
	lineCount: number,
): string {
	if (
		!theme.isColorEnabled() ||
		!language ||
		lineCount > MAX_HIGHLIGHT_LINES ||
		!supportsLanguage(language)
	) {
		return code;
	}
	try {
		return highlight(code, {
			language,
			ignoreIllegals: true,
			theme: mycliHighlightTheme(),
		});
	} catch {
		return code;
	}
}


function mycliHighlightTheme(): CliHighlightTheme {
	return {
		default: (text) => theme.fg("text", text),
		keyword: (text) => theme.fg("syntaxKeyword", text),
		built_in: (text) => theme.fg("syntaxType", text),
		type: (text) => theme.fg("syntaxType", text),
		literal: (text) => theme.fg("syntaxKeyword", text),
		class: (text) => theme.fg("syntaxType", text),
		title: (text) => theme.fg("syntaxFunction", text),
		function: (text) => theme.fg("syntaxFunction", text),
		params: (text) => theme.fg("syntaxVariable", text),
		variable: (text) => theme.fg("syntaxVariable", text),
		attr: (text) => theme.fg("syntaxVariable", text),
		string: (text) => theme.fg("syntaxString", text),
		regexp: (text) => theme.fg("syntaxString", text),
		number: (text) => theme.fg("syntaxNumber", text),
		comment: (text) => theme.fg("syntaxComment", text),
		doctag: (text) => theme.fg("syntaxComment", text),
	};
}
