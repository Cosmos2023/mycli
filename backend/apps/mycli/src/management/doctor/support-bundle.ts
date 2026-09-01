import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "@mycli/config";
import type { ConfigLayerRow } from "../config.ts";
import type { SandboxReadiness } from "@mycli/tools";
import type { WorkspaceTrustState } from "@mycli/config";
import { redactDoctorText } from "./redaction.ts";
import type {
	DoctorDiagnosticCheck,
	DoctorReport,
	DoctorStatus,
	DoctorSupportBundle,
	DoctorSupportBundleReceipt,
	DoctorSupportDiagnostic,
	DoctorSupportManifest,
	DoctorSupportReadinessSummary,
} from "./types.ts";

const SUPPORT_DIRECTORY = "support";
const SUPPORT_FILE = "diagnostic-support.json";
const MAX_SUPPORT_BYTES = 262_144;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const SAFE_LOG_REFERENCE_SET = new Set([
	"logs/agent.log",
	"logs/errors.log",
	"logs/model-events.jsonl",
	"logs/model-raw/",
	"traces/",
]);

export const DOCTOR_SAFE_LOG_REFERENCES = Object.freeze([...SAFE_LOG_REFERENCE_SET]);

export interface DoctorSupportBundleInput {
	readonly report: DoctorReport;
	readonly config: Readonly<{
		readonly workspaceTrust: WorkspaceTrustState;
		readonly layers: readonly ConfigLayerRow[];
	}>;
	readonly sandbox: SandboxReadiness;
}

export function buildDoctorSupportBundle(
	input: DoctorSupportBundleInput,
): DoctorSupportBundle {
	const diagnostics = Object.freeze(input.report.checks.slice(0, 128).map(supportDiagnostic));
	return Object.freeze({
		schemaVersion: 1,
		runtime: supportRuntime(input.report.support),
		configuration: Object.freeze({
			workspaceTrust: input.config.workspaceTrust,
			layers: Object.freeze(input.config.layers.slice(0, 16).map((layer) => Object.freeze({
				id: layer.id,
				scope: layer.scope,
				enabled: layer.enabled,
				...(layer.disabledReason ? { disabledReason: layer.disabledReason } : {}),
			}))),
		}),
		readiness: Object.freeze({
			sandbox: supportSandbox(input.sandbox),
			sessions: readinessSummary(input.report.checks.filter(isSessionCheck)),
			extensions: readinessSummary(input.report.checks.filter(
				(check) => check.category === "extension",
			)),
		}),
		diagnostics,
	});
}

export async function writeDoctorSupportBundle(
	homeDir: string,
	bundle: DoctorSupportBundle,
): Promise<DoctorSupportBundleReceipt> {
	const content = `${JSON.stringify(bundle, null, 2)}\n`;
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_SUPPORT_BYTES) throw new Error("support_bundle_too_large");
	await atomicPrivateFileUpdate({
		directory: join(homeDir, ".mycli", SUPPORT_DIRECTORY),
		fileName: SUPPORT_FILE,
		maxCurrentBytes: MAX_SUPPORT_BYTES,
		buildContent: () => content,
	});
	return Object.freeze({
		schemaVersion: 1,
		location: ".mycli/support/diagnostic-support.json",
		bytes,
		sha256: createHash("sha256").update(content, "utf8").digest("hex"),
	});
}

function supportRuntime(manifest: DoctorSupportManifest): DoctorSupportManifest {
	return Object.freeze({
		schemaVersion: 1,
		mycliVersion: supportText(manifest.mycliVersion, 64),
		nodeVersion: supportText(manifest.nodeVersion, 64),
		platform: manifest.platform,
		architecture: supportText(manifest.architecture, 32),
		diagnosticCodes: Object.freeze(manifest.diagnosticCodes
			.filter((code) => SAFE_CODE.test(code)).slice(0, 64)),
		logReferences: Object.freeze(manifest.logReferences
			.filter((reference) => SAFE_LOG_REFERENCE_SET.has(reference)).slice(0, 8)),
	});
}

function supportDiagnostic(check: DoctorDiagnosticCheck): DoctorSupportDiagnostic {
	const remediation = check.remediation === undefined
		? undefined
		: supportText(check.remediation, 512);
	return Object.freeze({
		category: check.category,
		code: SAFE_CODE.test(check.code) ? check.code : "diagnostic",
		status: check.status,
		summary: supportText(check.summary, 320) || "check completed",
		details: Object.freeze(check.details.map((detail) => supportText(detail, 512))
			.filter(Boolean).slice(0, 8)),
		...(remediation ? { remediation } : {}),
		recoveryActionIds: Object.freeze(check.recoveryActions
			.map((action) => action.id).filter((id) => SAFE_CODE.test(id)).slice(0, 4)),
	});
}

function supportSandbox(
	readiness: SandboxReadiness,
): DoctorSupportBundle["readiness"]["sandbox"] {
	return Object.freeze({
		state: supportText(readiness.state, 32),
		code: SAFE_CODE.test(readiness.code) ? readiness.code : "sandbox_unknown",
		platform: readiness.platform,
		isolation: supportText(readiness.isolation, 64),
		...(readiness.helperVersion === undefined
			? {} : { helperVersion: Math.max(0, Math.round(readiness.helperVersion)) }),
		...(readiness.helperCompatible === undefined
			? {} : { helperCompatible: readiness.helperCompatible }),
		...(readiness.setupComplete === undefined
			? {} : { setupComplete: readiness.setupComplete }),
		...(readiness.sandboxReady === undefined
			? {} : { sandboxReady: readiness.sandboxReady }),
	});
}

function readinessSummary(
	checks: readonly DoctorDiagnosticCheck[],
): DoctorSupportReadinessSummary {
	return Object.freeze({
		status: aggregateDoctorStatus(checks),
		codes: Object.freeze([...new Set(checks.map((check) => check.code)
			.filter((code) => SAFE_CODE.test(code)))].slice(0, 32)),
	});
}

function aggregateDoctorStatus(checks: readonly DoctorDiagnosticCheck[]): DoctorStatus {
	if (checks.some((check) => check.status === "failed")) return "failed";
	if (checks.some((check) => check.status === "warning")) return "warning";
	return "ok";
}

function isSessionCheck(check: DoctorDiagnosticCheck): boolean {
	return check.category === "storage"
		&& (check.name.includes("session") || check.code.includes("session"));
}

function supportText(value: string, limit: number): string {
	return redactLocalPaths(redactDoctorText(value)
		.replace(/\p{Cc}/gu, " ")
		.replace(/\bhttps?:\/\/[^\s,;]+/giu, "[URL]")
	).slice(0, limit);
}

function redactLocalPaths(value: string): string {
	return value
		.replace(/\b[A-Za-z]:[\\/][^\s,;)}\]"']+/gu, "[PATH]")
		.replace(/\\\\[^\s,;)}\]"']+/gu, "[PATH]")
		.replace(/(^|[\s("'=,:;])~[\\/][^\s,;)}\]"']+/gu, "$1[PATH]")
		.replace(/(^|[\s("'=,:;])\/(?!\/)[^\s,;)}\]"']+/gu, "$1[PATH]");
}
