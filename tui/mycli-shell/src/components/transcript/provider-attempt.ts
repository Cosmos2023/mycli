import { errorSummary, sanitizeRuntimeErrorDetail, type ProviderAttemptRecord } from "@mycli/contracts";
import type { MycliShellTranscriptBlock } from "../../model.ts";
import { hasProviderAttemptRetries } from "../../model.ts";
import { boundedUiText } from "../../safe-ui-text.ts";
import { Text } from "../../tui-core/components/text.ts";
import { Container } from "../../tui-core/tui.ts";
import { theme } from "../../theme/theme.ts";

type ProviderAttemptView = Extract<MycliShellTranscriptBlock, { kind: "provider_attempt" }>["providerAttempt"];

const STATE_LABELS: Readonly<Record<ProviderAttemptRecord["state"], string>> = {
	scheduled: "Retry scheduled", started: "Attempt started", failed: "Attempt failed", completed: "Completed",
	recovered: "Recovered", exhausted: "Retries exhausted", cancelled: "Request cancelled", unknown: "Attempt outcome unknown",
};

export class ProviderAttemptComponent extends Container {
	constructor(view: ProviderAttemptView) {
		super();
		const latest = view.records.at(-1);
		if (!latest) return;
		const label = !view.active && (latest.state === "started" || latest.state === "scheduled")
			? "Recovery paused" : stateLabel(latest);
		const budget = `request ${latest.requestRetriesUsed}/${latest.policy.requestMaxRetries}, stream ${latest.streamRetriesUsed}/${latest.policy.streamMaxRetries}`;
		this.addChild(new Text(theme.fg("muted",
			`${view.expanded ? "v" : ">"} ${label} | ${boundedUiText(latest.provider, "Provider", 80)}/${boundedUiText(latest.model, "model", 100)} | attempt ${latest.attempt} (${budget})`,
		), 1, 0));
		if (!view.expanded) {
			const detail = safeReason(latest);
			if (detail) this.addChild(new Text(theme.fg("dim", `  ${detail}`), 1, 0));
			return;
		}
		const visible = view.records.slice(-1000);
		if (visible[0]!.sequence > 1) {
			this.addChild(new Text(theme.fg("dim", "  Earlier retry history available"), 1, 0));
		}
		for (const record of visible) {
			this.addChild(new Text(theme.fg("dim",
				`  ${record.observedAt.slice(11, 19)} | ${record.attempt} | ${stateLabel(record)}${safeReason(record) ? `: ${safeReason(record)}` : ""}`,
			), 1, 0));
			const diagnostics = record.failure?.diagnostics;
			const facts = ["status", "provider_error_code", "provider_error_type", "request_id", "transport_error_code"]
				.flatMap((key) => {
					const value = diagnostics?.[key];
					if (value === undefined || value === null) return [];
					return [`${key}=${boundedUiText(String(value), "", 120)}`];
				});
			if (facts.length) this.addChild(new Text(theme.fg("dim", `    ${facts.join(" | ")}`), 1, 0));
		}
	}
}

function stateLabel(record: ProviderAttemptRecord): string {
	return record.state === "cancelled" && hasProviderAttemptRetries(record)
		? "Retry cancelled" : STATE_LABELS[record.state];
}

function safeReason(record: ProviderAttemptRecord): string | undefined {
	const reason = record.failure?.errorContext ? errorSummary(record.failure.errorContext)
		: sanitizeRuntimeErrorDetail(record.failure?.additionalDetails ?? record.failure?.message);
	return reason ? boundedUiText(reason, "", 240) : undefined;
}
