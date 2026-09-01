import {
	diagnosticRecoveryAction,
	isDiagnosticCategory,
	isDiagnosticRecoveryActionId,
	type DiagnosticCategory,
} from "@mycli/contracts";
import { redactDoctorText } from "./redaction.ts";
import { collectConfigChecks } from "./check-config.ts";
import type { WorkspaceTrustState } from "@mycli/config";
import { collectExtensionChecks } from "./check-extensions.ts";
import type { ExtensionDoctorOptions } from "./check-extensions.ts";
import { collectProcessChecks } from "./check-process.ts";
import { collectRuntimeChecks } from "./check-runtime.ts";
import { collectStorageChecks } from "./check-storage.ts";
import { collectTerminalChecks } from "./check-terminal.ts";
import { collectUpdateChecks } from "./check-update.ts";
import { MYCLI_VERSION } from "../../version.ts";
import type {
	DoctorCheck,
	DoctorCollector,
	DoctorCollectorResult,
	DoctorDiagnosticCheck,
	DoctorManagementResponse,
	DoctorReport,
	DoctorStatus,
} from "./types.ts";
import type {
	DoctorRepairExecution,
	DoctorSupportBundleReceipt,
} from "./types.ts";
import { DOCTOR_SAFE_LOG_REFERENCES } from "./support-bundle.ts";

const CHECK_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_MESSAGE_CHARS = 320;
const MAX_DETAIL_CHARS = 512;
const MAX_DETAILS = 8;
const MAX_REMEDIATION_CHARS = 512;
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

export type DoctorRunOptions = ExtensionDoctorOptions & {
	readonly workspaceTrust?: WorkspaceTrustState;
	readonly updateStatus?: Parameters<typeof collectUpdateChecks>[0];
};

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
		{ name: "process", collect: (collectorSignal) => collectProcessChecks(options, collectorSignal) },
		{ name: "terminal", collect: () => collectTerminalChecks({ env: options.env }) },
		...(options.updateStatus
			? [{ name: "updates", collect: () => collectUpdateChecks(options.updateStatus!) }]
			: []),
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
	const checks: DoctorDiagnosticCheck[] = [];
	for (const collector of collectors) {
		if (signal.aborted) throw abortError();
		const startedAt = performance.now();
		try {
			const collected = await collectWithTimeout(
				collector,
				signal,
				collectorTimeoutMs,
				cleanupTimeoutMs,
			);
			const durationMs = elapsedMilliseconds(startedAt);
			const rows = Array.isArray(collected) ? collected : [collected];
			for (const row of rows) checks.push(sanitizeCheck(row, collector.name, durationMs));
		} catch (error) {
			if (signal.aborted) throw abortError();
			checks.push(sanitizeCheck({
				name: safeName(collector.name, "diagnostic"),
				status: "failed",
				message: error instanceof DoctorCollectorTimeoutError
					? "diagnostic timed out"
					: "diagnostic failed",
			}, collector.name, elapsedMilliseconds(startedAt)));
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
	const frozenChecks = Object.freeze(checks.map((check) => sanitizeCheck(
		check,
		check.name,
		"durationMs" in check && typeof check.durationMs === "number" ? check.durationMs : 0,
	)));
	return Object.freeze({
		schemaVersion: 1,
		checks: frozenChecks,
		okCount: count(frozenChecks, "ok"),
		warningCount: count(frozenChecks, "warning"),
		failedCount: count(frozenChecks, "failed"),
		support: supportManifest(frozenChecks),
	});
}

export interface DoctorResponseOptions {
	readonly operation?: DoctorManagementResponse["operation"];
	readonly repair?: DoctorRepairExecution;
	readonly bundle?: DoctorSupportBundleReceipt;
	readonly issue?: string;
}

export function doctorResponseFromReport(
	report: DoctorReport,
	options: DoctorResponseOptions = {},
): DoctorManagementResponse {
	const normalized = reportFromChecks(report.checks);
	const operationFailed = options.issue !== undefined
		|| options.repair?.status === "failed"
		|| options.repair?.status === "partial_failure"
		|| options.repair?.status === "version_conflict";
	const failed = normalized.failedCount > 0 || operationFailed;
	return Object.freeze({
		ok: !failed,
		action: "doctor",
		operation: options.operation ?? "check",
		message: "mycli doctor",
		schemaVersion: normalized.schemaVersion,
		checks: normalized.checks,
		okCount: normalized.okCount,
		warningCount: normalized.warningCount,
		failedCount: normalized.failedCount,
		support: normalized.support,
		...(options.repair ? { repair: options.repair } : {}),
		...(options.bundle ? { bundle: options.bundle } : {}),
		...(options.issue ? { issues: Object.freeze([options.issue]) } : {}),
		exitCode: failed ? 1 : 0,
	});
}

function sanitizeCheck(
	check: DoctorCheck,
	fallbackName: string,
	durationMs: number,
): DoctorDiagnosticCheck {
	const name = safeName(check.name, safeName(fallbackName, "diagnostic"));
	const status = safeStatus(check.status);
	const message = boundedText(check.message, MAX_MESSAGE_CHARS) || "check completed";
	const category = isDiagnosticCategory(check.category)
		? check.category
		: inferredCategory(name, fallbackName);
	const code = safeName(check.code ?? name, name);
	const summary = boundedText(check.summary ?? message, MAX_MESSAGE_CHARS) || message;
	const details = sanitizedDetails(check);
	const detail = details[0];
	const remediation = check.remediation === undefined
		? undefined
		: boundedText(check.remediation, MAX_REMEDIATION_CHARS);
	const recoveryActions = recoveryActionsFor(check, category, status);
	return Object.freeze({
		name,
		status,
		message,
		category,
		code,
		summary,
		details,
		recoveryActions,
		durationMs: boundedDuration(durationMs),
		...(detail ? { detail } : {}),
		...(remediation ? { remediation } : {}),
	});
}

function sanitizedDetails(check: DoctorCheck): readonly string[] {
	const values = [
		...(Array.isArray(check.details) ? check.details : []),
		...(check.detail === undefined ? [] : [check.detail]),
	];
	return Object.freeze([...new Set(values.map((value) => boundedText(value, MAX_DETAIL_CHARS))
		.filter(Boolean))].slice(0, MAX_DETAILS));
}

function inferredCategory(name: string, collector: string): DiagnosticCategory {
	if (name === "api_key" || name.includes("credential") || name.includes("auth")) return "auth";
	if (name.includes("sandbox")) return "sandbox";
	if (name.includes("migration")) return "migration";
	if (name.includes("terminal") || name === "shell_selection" || collector === "terminal") {
		return "terminal";
	}
	if (collector === "config") return "config";
	if (collector === "storage") return "storage";
	if (collector === "extensions") return "extension";
	if (collector === "updates") return "update";
	return "runtime";
}

function recoveryActionsFor(
	check: DoctorCheck,
	category: DiagnosticCategory,
	status: DoctorStatus,
): readonly ReturnType<typeof diagnosticRecoveryAction>[] {
	const actions = Array.isArray(check.recoveryActions) ? check.recoveryActions : [];
	const requested = actions.flatMap((action) => {
		const id = typeof action === "object" && action !== null && "id" in action
			? action.id
			: undefined;
		return isDiagnosticRecoveryActionId(id) ? [id] : [];
	});
	if (requested.length > 0) {
		return Object.freeze([...new Set(requested)].slice(0, 4).map(diagnosticRecoveryAction));
	}
	if (status === "ok") return Object.freeze([]);
	if (category === "auth") return Object.freeze([diagnosticRecoveryAction("configure_credentials")]);
	if (category === "config") return Object.freeze([diagnosticRecoveryAction("inspect_configuration")]);
	if (status === "failed") return Object.freeze([diagnosticRecoveryAction("run_doctor")]);
	return Object.freeze([]);
}

function supportManifest(checks: readonly DoctorDiagnosticCheck[]): DoctorReport["support"] {
	return Object.freeze({
		schemaVersion: 1,
		mycliVersion: MYCLI_VERSION,
		nodeVersion: process.versions.node,
		platform: process.platform,
		architecture: process.arch.slice(0, 32),
		diagnosticCodes: Object.freeze(checks
			.filter((check) => check.status !== "ok")
			.map((check) => check.code)
			.slice(0, 64)),
		logReferences: DOCTOR_SAFE_LOG_REFERENCES,
	});
}

function elapsedMilliseconds(startedAt: number): number {
	return Math.max(0, Math.round(performance.now() - startedAt));
}

function boundedDuration(value: number): number {
	return Number.isFinite(value) ? Math.min(300_000, Math.max(0, Math.round(value))) : 0;
}

function safeName(value: unknown, fallback: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	return CHECK_NAME.test(normalized) ? normalized : fallback;
}

function safeStatus(value: unknown): DoctorStatus {
	return value === "ok" || value === "warning" || value === "failed" ? value : "failed";
}

function boundedText(value: unknown, limit: number): string {
	return typeof value === "string" ? redactDoctorText(value).trim().slice(0, limit) : "";
}

function count(checks: readonly DoctorDiagnosticCheck[], status: DoctorStatus): number {
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
