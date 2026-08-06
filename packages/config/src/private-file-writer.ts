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
	readonly buildContent: (current: string | undefined) => string;
	readonly failpoint?: (name: string) => void;
}

export async function atomicPrivateFileUpdate(
	options: AtomicPrivateFileUpdateOptions,
): Promise<void> {
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
		const current = await readOptional(targetPath);
		const content = options.buildContent(current);
		temporary = await open(temporaryPath, "wx", 0o600);
		await temporary.writeFile(content, "utf8");
		await temporary.sync();
		await temporary.close();
		temporary = undefined;
		options.failpoint?.("before_rename");
		await rename(temporaryPath, targetPath);
		await harden(targetPath, 0o600);
		await syncDirectory(options.directory);
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

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return undefined;
		throw error;
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
