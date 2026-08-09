import { redactDoctorText } from "./redaction.ts";
import { collectConfigChecks } from "./check-config.ts";
import { collectExtensionChecks } from "./check-extensions.ts";
import type { ExtensionDoctorOptions } from "./check-extensions.ts";
import { collectProcessChecks } from "./check-process.ts";
import { collectRuntimeChecks } from "./check-runtime.ts";
import { collectStorageChecks } from "./check-storage.ts";
import type {
	DoctorCheck,
	DoctorCollector,
	DoctorCollectorResult,
	DoctorManagementResponse,
	DoctorReport,
	DoctorStatus,
} from "./types.ts";

const CHECK_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_MESSAGE_CHARS = 320;
const MAX_DETAIL_CHARS = 512;
const DEFAULT_COLLECTOR_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;

export interface DoctorRunnerOptions {
	readonly collectorTimeoutMs?: number;
	readonly cleanupTimeoutMs?: number;
}

class DoctorCollectorTimeoutError extends Error {
	constructor() {
		super("doctor_collector_timeout");
		this.name = "DoctorCollectorTimeoutError";
	}
}

export type DoctorRunOptions = ExtensionDoctorOptions;

export function runDoctor(
	options: DoctorRunOptions,
	signal = new AbortController().signal,
): Promise<DoctorReport> {
	return runDoctorCollectors([
		{ name: "config", collect: () => collectConfigChecks(options) },
		{ name: "storage", collect: () => collectStorageChecks(options) },
		{ name: "runtime", collect: () => collectRuntimeChecks() },
		{ name: "extensions", collect: (collectorSignal) => (
			collectExtensionChecks(options, collectorSignal)
		) },
		{ name: "process", collect: () => collectProcessChecks(options) },
	], signal);
}

export async function runDoctorCollectors(
	collectors: readonly DoctorCollector[],
	signal = new AbortController().signal,
	options: DoctorRunnerOptions = {},
): Promise<DoctorReport> {
	const collectorTimeoutMs = timeoutValue(
		options.collectorTimeoutMs,
		DEFAULT_COLLECTOR_TIMEOUT_MS,
	);
	const cleanupTimeoutMs = timeoutValue(
		options.cleanupTimeoutMs,
		DEFAULT_CLEANUP_TIMEOUT_MS,
	);
	const checks: DoctorCheck[] = [];
	for (const collector of collectors) {
		if (signal.aborted) throw abortError();
		try {
			const collected = await collectWithTimeout(
				collector,
				signal,
				collectorTimeoutMs,
				cleanupTimeoutMs,
			);
			const rows = Array.isArray(collected) ? collected : [collected];
			for (const row of rows) checks.push(sanitizeCheck(row, collector.name));
		} catch (error) {
			if (signal.aborted) throw abortError();
			checks.push(Object.freeze({
				name: safeName(collector.name, "diagnostic"),
				status: "failed",
				message: error instanceof DoctorCollectorTimeoutError
					? "diagnostic timed out"
					: "diagnostic failed",
			}));
		}
	}
	return reportFromChecks(checks);
}

async function collectWithTimeout(
	collector: DoctorCollector,
	parentSignal: AbortSignal,
	timeoutMs: number,
	cleanupTimeoutMs: number,
): Promise<DoctorCollectorResult> {
	const controller = new AbortController();
	let timedOut = false;
	let timeout: NodeJS.Timeout | undefined;
	let rejectParent: ((error: Error) => void) | undefined;
	const onParentAbort = (): void => {
		controller.abort();
		rejectParent?.(abortError());
	};
	parentSignal.addEventListener("abort", onParentAbort, { once: true });
	if (parentSignal.aborted) onParentAbort();

	const operation = Promise.resolve().then(() => collector.collect(controller.signal));
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(new DoctorCollectorTimeoutError());
		}, timeoutMs);
	});
	const parentAbort = new Promise<never>((_, reject) => {
		rejectParent = reject;
		if (parentSignal.aborted) reject(abortError());
	});

	try {
		return await Promise.race([operation, deadline, parentAbort]);
	} catch (error) {
		if (timedOut || parentSignal.aborted) {
			await waitForCleanup(operation, cleanupTimeoutMs);
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		rejectParent = undefined;
		parentSignal.removeEventListener("abort", onParentAbort);
	}
}

async function waitForCleanup(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			operation.then(() => undefined, () => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function reportFromChecks(checks: readonly DoctorCheck[]): DoctorReport {
	const frozenChecks = Object.freeze(checks.map((check) => sanitizeCheck(check, check.name)));
	return Object.freeze({
		checks: frozenChecks,
		okCount: count(frozenChecks, "ok"),
		warningCount: count(frozenChecks, "warning"),
		failedCount: count(frozenChecks, "failed"),
	});
}

export function doctorResponseFromReport(report: DoctorReport): DoctorManagementResponse {
	const normalized = reportFromChecks(report.checks);
	const failed = normalized.failedCount > 0;
	return Object.freeze({
		ok: !failed,
		action: "doctor",
		message: "mycli doctor",
		checks: normalized.checks,
		okCount: normalized.okCount,
		warningCount: normalized.warningCount,
		failedCount: normalized.failedCount,
		exitCode: failed ? 1 : 0,
	});
}

function sanitizeCheck(check: DoctorCheck, fallbackName: string): DoctorCheck {
	const name = safeName(check.name, safeName(fallbackName, "diagnostic"));
	const status = safeStatus(check.status);
	const message = boundedText(check.message, MAX_MESSAGE_CHARS) || "check completed";
	const detail = check.detail === undefined
		? undefined
		: boundedText(check.detail, MAX_DETAIL_CHARS);
	return Object.freeze({
		name,
		status,
		message,
		...(detail ? { detail } : {}),
	});
}

function safeName(value: string, fallback: string): string {
	const normalized = value.trim();
	return CHECK_NAME.test(normalized) ? normalized : fallback;
}

function safeStatus(value: DoctorStatus): DoctorStatus {
	return value === "ok" || value === "warning" || value === "failed" ? value : "failed";
}

function boundedText(value: string, limit: number): string {
	return redactDoctorText(value).trim().slice(0, limit);
}

function count(checks: readonly DoctorCheck[], status: DoctorStatus): number {
	return checks.reduce((total, check) => total + Number(check.status === status), 0);
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

function timeoutValue(value: number | undefined, fallback: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 300_000) {
		throw new RangeError("invalid_doctor_timeout");
	}
	return selected;
}
