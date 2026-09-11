import type {
	MycliShellCommandDiagnostic,
	MycliShellDiagnosticMetric,
	MycliShellDiagnosticSection,
} from "../model.ts";
import { recordValue, stringArrayValue, stringValue } from "./payload-values.ts";
import type { RuntimeTranscriptItem } from "./runtime-state-model.ts";

export function diagnosticFromTranscriptItem(item: RuntimeTranscriptItem): MycliShellCommandDiagnostic | null {
	const metadata = recordValue(item.metadata);
	const diagnostic = recordValue(metadata.diagnostic);
	const command = stringValue(diagnostic.command) ?? stringValue(metadata.command);
	const title = stringValue(diagnostic.title);
	if (!command || !title) {
		return null;
	}
	const kind = diagnosticKindValue(diagnostic.kind);
	return {
		id: item.id,
		command,
		title,
		kind,
		metrics: diagnosticMetricsFromUnknown(diagnostic.metrics),
		sections: diagnosticSectionsFromUnknown(diagnostic.sections),
		rawLines: stringArrayValue(diagnostic.rawLines ?? diagnostic.raw_lines),
	};
}

function diagnosticKindValue(value: unknown): MycliShellCommandDiagnostic["kind"] {
	return value === "usage" || value === "context" ? value : "generic";
}

function diagnosticMetricsFromUnknown(value: unknown): MycliShellDiagnosticMetric[] {
	if (!Array.isArray(value)) return [];
	return value.map(diagnosticMetricFromUnknown).filter((item): item is MycliShellDiagnosticMetric => item !== null);
}

function diagnosticMetricFromUnknown(value: unknown): MycliShellDiagnosticMetric | null {
	const record = recordValue(value);
	const label = stringValue(record.label);
	const metricValue = stringValue(record.value);
	if (!label || metricValue === null) return null;
	const metric: MycliShellDiagnosticMetric = {
		label,
		value: metricValue,
	};
	const accent = diagnosticAccentValue(record.accent);
	if (accent) {
		metric.accent = accent;
	}
	return metric;
}

function diagnosticSectionsFromUnknown(value: unknown): MycliShellDiagnosticSection[] {
	if (!Array.isArray(value)) return [];
	return value.map(diagnosticSectionFromUnknown).filter((item): item is MycliShellDiagnosticSection => item !== null);
}

function diagnosticSectionFromUnknown(value: unknown): MycliShellDiagnosticSection | null {
	const record = recordValue(value);
	const title = stringValue(record.title);
	if (!title) return null;
	return {
		title,
		rows: diagnosticMetricsFromUnknown(record.rows),
	};
}

function diagnosticAccentValue(value: unknown): MycliShellDiagnosticMetric["accent"] | undefined {
	if (value === "success" || value === "warning" || value === "error" || value === "accent" || value === "muted") {
		return value;
	}
	return undefined;
}
