import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	open,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import AdmZip from "adm-zip";
import { extract as extractTar } from "tar";
import {
	RIPGREP_TARGETS,
	RIPGREP_VERSION,
	isRipgrepTarget,
	ripgrepOutputPath,
	ripgrepPlatformKey,
	type RipgrepTarget,
} from "./ripgrep-targets.ts";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const MAX_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_BINARY_BYTES = 16 * 1024 * 1024;

type DownloadArchive = (url: string, destination: string, signal: AbortSignal) => Promise<void>;
type VerifyArchive = (path: string, expectedSha256: string) => Promise<void>;
type ExtractMember = (archive: string, member: string, destinationRoot: string) => Promise<string>;

export interface PrepareUserRipgrepOptions {
	readonly target?: string;
	readonly destinationRoot?: string;
	readonly force?: boolean;
	readonly downloadTimeoutMs?: number;
	readonly downloadAttempts?: number;
	readonly signal?: AbortSignal;
	readonly downloadArchive?: DownloadArchive;
	readonly verifyArchive?: VerifyArchive;
	readonly extractMember?: ExtractMember;
}

export interface RipgrepPrepareResult {
	readonly path: string;
	readonly installed: boolean;
}

export async function prepareUserRipgrep(
	options: PrepareUserRipgrepOptions = {},
): Promise<RipgrepPrepareResult> {
	const target = resolveTarget(options.target);
	const destinationRoot = options.destinationRoot ?? defaultUserRipgrepRoot();
	const outputPath = ripgrepOutputPath(destinationRoot, target);
	if (!options.force && await exists(outputPath)) {
		return Object.freeze({ path: outputPath, installed: false });
	}
	const downloadTimeoutMs = resolveDownloadTimeout(options.downloadTimeoutMs);
	const downloadAttempts = resolveDownloadAttempts(options.downloadAttempts);

	const targetInfo = RIPGREP_TARGETS[target];
	const outputDirectory = dirname(outputPath);
	await mkdir(outputDirectory, { recursive: true });
	const temporaryRoot = await mkdtemp(join(outputDirectory, ".prepare-"));
	const archivePath = join(temporaryRoot, targetInfo.archive);
	const extractedRoot = join(temporaryRoot, "extracted");
	const stagedPath = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp`);
	const timeoutSignal = AbortSignal.timeout(downloadTimeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutSignal])
		: timeoutSignal;
	try {
		signal.throwIfAborted();
		const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${targetInfo.archive}`;
		await downloadWithRetries(
			options.downloadArchive ?? downloadRipgrepArchive,
			url,
			archivePath,
			signal,
			downloadAttempts,
		);
		signal.throwIfAborted();
		await (options.verifyArchive ?? verifyRipgrepArchive)(archivePath, targetInfo.sha256);
		signal.throwIfAborted();
		await mkdir(extractedRoot);
		const extractedPath = await (options.extractMember ?? extractRipgrepMember)(
			archivePath,
			targetInfo.member,
			extractedRoot,
		);
		signal.throwIfAborted();
		await assertBoundedFile(extractedPath);
		await copyFile(extractedPath, stagedPath);
		await chmod(stagedPath, 0o755);
		await rename(stagedPath, outputPath);
		return Object.freeze({ path: outputPath, installed: true });
	} finally {
		await Promise.all([
			rm(stagedPath, { force: true }),
			rm(temporaryRoot, { recursive: true, force: true }),
		]);
	}
}

async function downloadWithRetries(
	download: DownloadArchive,
	url: string,
	destination: string,
	signal: AbortSignal,
	attempts: number,
): Promise<void> {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await download(url, destination, signal);
			return;
		} catch (error) {
			await rm(destination, { force: true });
			signal.throwIfAborted();
			if (attempt === attempts) throw error;
			await delay(250 * attempt, undefined, { signal });
		}
	}
}

function resolveDownloadAttempts(value: number | undefined): number {
	if (value === undefined) return 1;
	if (!Number.isInteger(value) || value <= 0 || value > MAX_DOWNLOAD_ATTEMPTS) {
		throw new TypeError("ripgrep download attempts must be between 1 and 3");
	}
	return value;
}

function resolveDownloadTimeout(value: number | undefined): number {
	if (value === undefined) return DOWNLOAD_TIMEOUT_MS;
	if (!Number.isInteger(value) || value <= 0 || value > MAX_DOWNLOAD_TIMEOUT_MS) {
		throw new TypeError("ripgrep download timeout must be between 1 and 300000 milliseconds");
	}
	return value;
}

export function defaultUserRipgrepRoot(homeDir: string = homedir()): string {
	return join(homeDir, ".mycli", "vendor", "ripgrep");
}

export async function downloadRipgrepArchive(
	url: string,
	destination: string,
	signal: AbortSignal,
): Promise<void> {
	const response = await fetch(url, { redirect: "follow", signal });
	if (!response.ok || !response.body) {
		throw new Error(`ripgrep download failed with status ${response.status}`);
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
		throw new Error("ripgrep archive exceeds size limit");
	}
	const handle = await open(destination, "wx", 0o600);
	let received = 0;
	try {
		for await (const chunk of response.body) {
			const buffer = Buffer.from(chunk);
			received += buffer.byteLength;
			if (received > MAX_ARCHIVE_BYTES) throw new Error("ripgrep archive exceeds size limit");
			let offset = 0;
			while (offset < buffer.byteLength) {
				const { bytesWritten } = await handle.write(buffer, offset);
				if (bytesWritten <= 0) throw new Error("ripgrep archive write made no progress");
				offset += bytesWritten;
			}
		}
	} finally {
		await handle.close();
	}
}

export async function verifyRipgrepArchive(path: string, expectedSha256: string): Promise<void> {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	const actual = digest.digest("hex");
	if (actual !== expectedSha256.toLowerCase()) {
		throw new Error(`ripgrep sha256 mismatch for ${basename(path)}`);
	}
}

export async function extractRipgrepMember(
	archivePath: string,
	member: string,
	destinationRoot: string,
): Promise<string> {
	await mkdir(destinationRoot, { recursive: true });
	const outputPath = safeMemberPath(destinationRoot, member);
	if (archivePath.endsWith(".zip")) {
		const archive = new AdmZip(archivePath);
		const entry = archive.getEntry(member);
		if (!entry || entry.isDirectory || entry.header.size > MAX_BINARY_BYTES) {
			throw new Error("ripgrep archive member is missing or invalid");
		}
		const data = archive.readFile(entry);
		if (!data || data.byteLength > MAX_BINARY_BYTES) {
			throw new Error("ripgrep archive member is missing or invalid");
		}
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, data, { mode: 0o700 });
	} else {
		await extractTar({
			cwd: destinationRoot,
			file: archivePath,
			filter: (path) => path === member,
			preservePaths: false,
			strict: true,
		}, [member]);
	}
	await assertBoundedFile(outputPath);
	return outputPath;
}

function resolveTarget(target: string | undefined): RipgrepTarget {
	if (!target) return ripgrepPlatformKey();
	if (!isRipgrepTarget(target)) throw new Error(`unsupported ripgrep target: ${target}`);
	return target;
}

function safeMemberPath(destinationRoot: string, member: string): string {
	const root = resolve(destinationRoot);
	const target = resolve(root, member);
	if (target !== root && target.startsWith(`${root}${sep}`)) return target;
	throw new Error("ripgrep archive member escapes destination");
}

async function assertBoundedFile(path: string): Promise<void> {
	const metadata = await stat(path);
	if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_BINARY_BYTES) {
		throw new Error("ripgrep archive member is missing or invalid");
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
