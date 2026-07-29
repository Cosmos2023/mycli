import type { MycliShellSession } from "../model.ts";
import { fuzzyMatch } from "../tui-core/fuzzy.ts";

export type SessionSortMode = "recent" | "relevance";
export type SessionNameFilter = "all" | "named";
export type SessionScope = "current" | "all";

export interface ParsedSessionSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	error?: string;
}

interface SessionMatchResult {
	matches: boolean;
	score: number;
}

function normalizedText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function sessionDisplayTitle(session: MycliShellSession): string {
	return session.title?.trim() || session.firstMessage?.trim() || session.id;
}

function sessionIsNamed(session: MycliShellSession): boolean {
	return Boolean(session.title?.trim() || session.named);
}

function sessionSearchText(session: MycliShellSession): string {
	return [
		session.id,
		session.title,
		session.cwd,
		session.workspace,
		session.modified,
		session.created,
		session.firstMessage,
		session.allMessagesText,
		session.messageCount?.toString(),
	].filter(Boolean).join(" ");
}

export function parseSessionSearchQuery(query: string): ParsedSessionSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (error) {
			return { mode: "regex", tokens: [], regex: null, error: error instanceof Error ? error.message : String(error) };
		}
	}

	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buffer = "";
	let inQuote = false;

	const flush = (kind: "fuzzy" | "phrase") => {
		const value = buffer.trim();
		buffer = "";
		if (value) {
			tokens.push({ kind, value });
		}
	};

	for (const char of trimmed) {
		if (char === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}
		if (!inQuote && /\s/u.test(char)) {
			flush("fuzzy");
			continue;
		}
		buffer += char;
	}

	if (inQuote) {
		return {
			mode: "tokens",
			tokens: trimmed.split(/\s+/u).filter(Boolean).map((value) => ({ kind: "fuzzy", value })),
			regex: null,
		};
	}

	flush("fuzzy");
	return { mode: "tokens", tokens, regex: null };
}

function matchSession(session: MycliShellSession, parsed: ParsedSessionSearchQuery): SessionMatchResult {
	const text = sessionSearchText(session);
	if (parsed.mode === "regex") {
		if (!parsed.regex) return { matches: false, score: 0 };
		const index = text.search(parsed.regex);
		return index >= 0 ? { matches: true, score: index * 0.1 } : { matches: false, score: 0 };
	}
	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let score = 0;
	let normalized: string | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			normalized ??= normalizedText(text);
			const phrase = normalizedText(token.value);
			const index = normalized.indexOf(phrase);
			if (index < 0) return { matches: false, score: 0 };
			score += index * 0.1;
			continue;
		}
		const match = fuzzyMatch(token.value, text);
		if (!match.matches) return { matches: false, score: 0 };
		score += match.score;
	}
	return { matches: true, score };
}

export function filterSessions(
	sessions: MycliShellSession[],
	options: {
		query: string;
		scope: SessionScope;
		sortMode: SessionSortMode;
		nameFilter: SessionNameFilter;
		currentWorkspace?: string;
	},
): MycliShellSession[] {
	const currentWorkspace = options.currentWorkspace?.trim();
	const scoped =
		options.scope === "current" && currentWorkspace
			? sessions.filter((session) => (session.cwd ?? session.workspace) === currentWorkspace)
			: sessions;
	const named = options.nameFilter === "named" ? scoped.filter(sessionIsNamed) : scoped;
	const parsed = parseSessionSearchQuery(options.query);
	if (parsed.error) return [];
	const scored: { session: MycliShellSession; score: number }[] = [];
	for (const session of named) {
		const match = matchSession(session, parsed);
		if (match.matches) {
			scored.push({ session, score: match.score });
		}
	}
	if (options.sortMode === "relevance" && options.query.trim()) {
		return scored
			.sort((a, b) => a.score - b.score || compareRecent(b.session, a.session))
			.map(({ session }) => session);
	}
	return scored.map(({ session }) => session).sort(compareRecent);
}

function compareRecent(a: MycliShellSession, b: MycliShellSession): number {
	return dateValue(b.modified ?? b.lastActive) - dateValue(a.modified ?? a.lastActive) || a.id.localeCompare(b.id);
}

function dateValue(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}
