import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	rm,
} from "node:fs/promises";
import { join } from "node:path";

const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 10;

export interface AtomicPrivateFileUpdateOptions {
	readonly directory: string;
	readonly fileName: string;
	readonly maxCurrentBytes?: number;
	readonly buildContent: (
		current: string | undefined,
	) => string | null | undefined | Promise<string | null | undefined>;
	readonly prepareCommit?: (input: {
		readonly current: string | undefined;
		readonly content: string | null;
	}) => void | Promise<void>;
	readonly failpoint?: (name: string) => void;
}

export async function atomicPrivateFileUpdate(
	options: AtomicPrivateFileUpdateOptions,
): Promise<boolean> {
	if (options.maxCurrentBytes !== undefined
		&& (!Number.isSafeInteger(options.maxCurrentBytes) || options.maxCurrentBytes <= 0)) {
		throw new RangeError("invalid_private_file_read_limit");
	}
	await mkdir(options.directory, { recursive: true, mode: 0o700 });
	await harden(options.directory, 0o700);
	const lockPath = join(options.directory, `.${options.fileName}.lock`);
	const targetPath = join(options.directory, options.fileName);
	const temporaryPath = join(
		options.directory,
		`.${options.fileName}.${process.pid}.${randomUUID()}.tmp`,
	);
	let lock: Awaited<ReturnType<typeof open>> | undefined;
	let temporary: Awaited<ReturnType<typeof open>> | undefined;
	try {
		lock = await acquireLock(lockPath);
		await lock.writeFile(`${process.pid}\n`, "utf8");
		await lock.sync();
		const current = await readOptional(targetPath, options.maxCurrentBytes);
		const content = await options.buildContent(current);
		if (content === undefined || content === current) return false;
		if (content === null) {
			if (current === undefined) return false;
			await options.prepareCommit?.({ current, content });
			options.failpoint?.("before_rename");
			await rm(targetPath);
			await syncDirectory(options.directory);
			return true;
		}
		temporary = await open(temporaryPath, "wx", 0o600);
		await temporary.writeFile(content, "utf8");
		await temporary.sync();
		await temporary.close();
		temporary = undefined;
		await options.prepareCommit?.({ current, content });
		options.failpoint?.("before_rename");
		await rename(temporaryPath, targetPath);
		await harden(targetPath, 0o600);
		await syncDirectory(options.directory);
		return true;
	} finally {
		await temporary?.close().catch(() => undefined);
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		await lock?.close().catch(() => undefined);
		if (lock) await rm(lockPath, { force: true }).catch(() => undefined);
	}
}

async function acquireLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			return await open(path, "wx", 0o600);
		} catch (error) {
			if (!isNodeError(error, "EEXIST") || Date.now() >= deadline) throw error;
			await delay(LOCK_RETRY_MS);
		}
	}
}

async function readOptional(path: string, maxBytes: number | undefined): Promise<string | undefined> {
	if (maxBytes === undefined) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return undefined;
			throw error;
		}
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size > maxBytes) return undefined;
		const content = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < content.length) {
			const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return content.subarray(0, offset).toString("utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return undefined;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function harden(path: string, mode: number): Promise<void> {
	try {
		await chmod(path, mode);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch {
		// Directory fsync is unsupported by some platforms and filesystems.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
