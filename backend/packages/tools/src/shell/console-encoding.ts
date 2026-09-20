import { spawnSync } from "node:child_process";

const CODE_PAGE_ENCODINGS: Readonly<Record<number, string>> = Object.freeze({
	874: "windows-874",
	932: "shift_jis",
	936: "gbk",
	949: "euc-kr",
	950: "big5",
	1250: "windows-1250",
	1251: "windows-1251",
	1252: "windows-1252",
	1253: "windows-1253",
	1254: "windows-1254",
	1255: "windows-1255",
	1256: "windows-1256",
	1257: "windows-1257",
	1258: "windows-1258",
});

let cached: string | undefined | null = null;

/**
 * Legacy Windows children (cmd.exe, some runtimes) write pipe output in the
 * OEM code page regardless of `chcp`. Detect it once so console output can be
 * decoded instead of producing replacement characters.
 */
export function windowsConsoleFallbackEncoding(
	platform: NodeJS.Platform = process.platform,
	query: (command: string, args: readonly string[]) => string | undefined = queryOemCodePage,
): string | undefined {
	if (platform !== "win32") return undefined;
	if (query === queryOemCodePage && cached !== null) return cached;
	const output = query("reg.exe", [
		"query",
		"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
		"/v",
		"OEMCP",
	]);
	const match = output === undefined ? null : /OEMCP\s+REG_SZ\s+(\d+)/u.exec(output);
	const encoding = match === null ? undefined : encodingForCodePage(Number(match[1]));
	if (query === queryOemCodePage) cached = encoding;
	return encoding;
}

function encodingForCodePage(codePage: number | undefined): string | undefined {
	if (codePage === undefined || codePage === 65001) return undefined;
	return CODE_PAGE_ENCODINGS[codePage];
}

function queryOemCodePage(command: string, args: readonly string[]): string | undefined {
	try {
		const result = spawnSync(command, [...args], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 5_000,
		});
		return typeof result.stdout === "string" ? result.stdout : undefined;
	} catch {
		return undefined;
	}
}
