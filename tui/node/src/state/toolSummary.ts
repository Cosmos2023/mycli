export type ToolSummaryInput = {
  tool_name?: unknown;
  text?: unknown;
  metadata?: unknown;
};

export type ToolSummary = {
  verb: string;
  target: string;
  status: "running" | "done" | "failed" | "unknown";
  detail?: string;
};

function metadataOf(input: ToolSummaryInput): Record<string, unknown> {
  return typeof input.metadata === "object" && input.metadata !== null
    ? (input.metadata as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusFrom(metadata: Record<string, unknown>): ToolSummary["status"] {
  if (metadata.status === "running") {
    return "running";
  }
  if (metadata.status === "failed" || metadata.error === true) {
    return "failed";
  }
  if ("exit_code" in metadata || "duration_ms" in metadata || metadata.status === "done") {
    return "done";
  }
  return "unknown";
}

function summaryWithDetail(
  summary: Omit<ToolSummary, "detail">,
  detail: string | undefined,
): ToolSummary {
  return detail === undefined ? summary : { ...summary, detail };
}

export function formatToolSummary(input: ToolSummaryInput): ToolSummary {
  const metadata = metadataOf(input);
  const name = stringValue(input.tool_name) ?? "Tool";
  const normalized = name.toLowerCase();
  const status = statusFrom(metadata);
  const duration = numberValue(metadata.duration_ms);
  const durationDetail = duration === null ? undefined : `${duration}ms`;

  if (normalized === "read") {
    return summaryWithDetail(
      {
        verb: "read",
        target: stringValue(metadata.path) ?? stringValue(input.text) ?? "file",
        status: status === "unknown" ? "done" : status,
      },
      durationDetail,
    );
  }
  if (normalized === "edit" || normalized === "write") {
    const additions = numberValue(metadata.additions);
    const deletions = numberValue(metadata.deletions);
    const detail =
      additions !== null || deletions !== null
        ? `+${additions ?? 0} -${deletions ?? 0}`
        : durationDetail;
    return summaryWithDetail(
      {
        verb: normalized,
        target: stringValue(metadata.path) ?? stringValue(input.text) ?? "file",
        status: status === "unknown" ? "done" : status,
      },
      detail,
    );
  }
  if (normalized === "bash") {
    const exitCode = numberValue(metadata.exit_code);
    return summaryWithDetail(
      {
        verb: "bash",
        target: stringValue(metadata.command) ?? stringValue(input.text) ?? "command",
        status: exitCode === null ? status : exitCode === 0 ? "done" : "failed",
      },
      exitCode === null ? durationDetail : `exit ${exitCode}`,
    );
  }
  if (normalized === "grep") {
    const matches = numberValue(metadata.matches);
    return summaryWithDetail(
      {
        verb: "grep",
        target: stringValue(metadata.query) ?? stringValue(input.text) ?? "pattern",
        status: status === "unknown" ? "done" : status,
      },
      matches === null ? durationDetail : `${matches} matches`,
    );
  }
  return summaryWithDetail(
    {
      verb: normalized,
      target: stringValue(metadata.path) ?? stringValue(input.text) ?? "tool call",
      status,
    },
    durationDetail,
  );
}
