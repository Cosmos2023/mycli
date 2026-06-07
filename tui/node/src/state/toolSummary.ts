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
  hint?: string;
  reason?: string;
  changes?: string;
};

function metadataOf(input: ToolSummaryInput): Record<string, unknown> {
  return typeof input.metadata === "object" && input.metadata !== null
    ? (input.metadata as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function fileChangeEntries(metadata: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = metadata.file_changes;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function changePath(entry: Record<string, unknown>): string | null {
  return (
    stringValue(entry.path) ??
    stringValue(entry.file_path) ??
    stringValue(entry.target) ??
    stringValue(entry.name)
  );
}

function compactChangeKind(kind: string | null): string {
  switch ((kind ?? "").toLowerCase()) {
    case "write":
    case "create":
    case "created":
    case "add":
    case "added":
      return "add";
    case "edit":
    case "modify":
    case "modified":
    case "update":
    case "updated":
      return "modify";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "delete";
    default:
      return "change";
  }
}

function changedFilesSummary(metadata: Record<string, unknown>): string | undefined {
  const entries = fileChangeEntries(metadata);
  if (entries.length === 0) {
    return undefined;
  }
  const paths = entries.map(changePath).filter((value): value is string => value !== null);
  const uniquePaths = [...new Set(paths)];
  const kindCounts = new Map<string, number>();
  for (const entry of entries) {
    const kind = compactChangeKind(stringValue(entry.kind) ?? stringValue(entry.operation));
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const kindText = [...kindCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(" ");
  const countText =
    uniquePaths.length === 1 ? "1 file changed" : `${uniquePaths.length} files changed`;
  const shown = uniquePaths.slice(0, 3).join(", ");
  const hidden = Math.max(uniquePaths.length - 3, 0);
  const pathText = shown ? `: ${shown}${hidden > 0 ? ` +${hidden}` : ""}` : "";
  return `${countText}${kindText ? ` (${kindText})` : ""}${pathText}`;
}

function statusFrom(metadata: Record<string, unknown>): ToolSummary["status"] {
  if (metadata.success === false) {
    return "failed";
  }
  if (metadata.success === true) {
    return "done";
  }
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

function lifecycleTarget(metadata: Record<string, unknown>): string | null {
  return (
    stringValue(metadata.path) ??
    stringValue(metadata.query) ??
    stringValue(metadata.command) ??
    stringValue(metadata.context) ??
    stringValue(metadata.summary) ??
    stringValue(metadata.args_preview)
  );
}

function durationDetailFrom(metadata: Record<string, unknown>): string | undefined {
  const durationMs = numberValue(metadata.duration_ms);
  if (durationMs !== null) {
    return `${durationMs}ms`;
  }
  const durationSeconds = numberValue(metadata.duration_s);
  if (durationSeconds === null) {
    return undefined;
  }
  if (durationSeconds < 1) {
    return `${Math.round(durationSeconds * 1000)}ms`;
  }
  return `${durationSeconds.toFixed(1)}s`;
}

function failureReasonFrom(metadata: Record<string, unknown>): string | undefined {
  const exitCode = numberValue(metadata.exit_code);
  if (exitCode !== null && exitCode !== 0) {
    return `exit ${exitCode}`;
  }
  const timeoutSeconds = numberValue(metadata.timeout_s) ?? numberValue(metadata.timeout_seconds);
  if (timeoutSeconds !== null) {
    return `timeout ${timeoutSeconds}s`;
  }
  if (booleanValue(metadata.approval_denied) === true || metadata.status === "denied") {
    return "denied";
  }
  if (metadata.status === "blocked") {
    return "blocked";
  }
  if (metadata.status === "unavailable") {
    return "unavailable";
  }
  if (metadata.status === "protocol_error") {
    return "protocol error";
  }
  return (
    stringValue(metadata.error_kind) ??
    stringValue(metadata.reason) ??
    stringValue(metadata.error) ??
    undefined
  );
}

function sideEffectHintFrom(metadata: Record<string, unknown>): string | undefined {
  const changedFiles = changedFilesSummary(metadata);
  if (changedFiles !== undefined) {
    return changedFiles;
  }
  const filesChanged = numberValue(metadata.files_changed);
  if (filesChanged !== null) {
    return filesChanged === 0 ? "no files changed" : `${filesChanged} files changed`;
  }
  if (booleanValue(metadata.side_effects) === false) {
    return "no side effects";
  }
  return stringValue(metadata.side_effect_status) ?? undefined;
}

function logHintFrom(metadata: Record<string, unknown>): string | undefined {
  return (
    stringValue(metadata.log_ref) ??
    stringValue(metadata.logs_ref) ??
    stringValue(metadata.details_ref) ??
    undefined
  );
}

function summaryWithDetails(
  summary: Omit<ToolSummary, "detail" | "hint" | "reason">,
  metadata: Record<string, unknown>,
  detail: string | undefined,
): ToolSummary {
  const reason = summary.status === "failed" ? failureReasonFrom(metadata) : undefined;
  const sideEffectHint = summary.status === "failed" ? sideEffectHintFrom(metadata) : undefined;
  const logHint = summary.status === "failed" ? logHintFrom(metadata) : undefined;
  const hintParts = [sideEffectHint, logHint ? `details: ${logHint}` : undefined].filter(
    (value): value is string => Boolean(value),
  );
  const changes = summary.status === "failed" ? undefined : changedFilesSummary(metadata);
  return {
    ...summary,
    ...(detail === undefined ? {} : { detail }),
    ...(reason === undefined ? {} : { reason }),
    ...(hintParts.length === 0 ? {} : { hint: hintParts.join(" · ") }),
    ...(changes === undefined ? {} : { changes }),
  };
}

export function formatToolSummary(input: ToolSummaryInput): ToolSummary {
  const metadata = metadataOf(input);
  const args = recordValue(metadata.arguments);
  const name = stringValue(input.tool_name) ?? "Tool";
  const normalized = name.toLowerCase();
  const status = statusFrom(metadata);
  const durationDetail = durationDetailFrom(metadata);

  if (normalized === "read") {
    return summaryWithDetails(
      {
        verb: "read",
        target:
          stringValue(metadata.path) ??
          stringValue(metadata.context) ??
          stringValue(metadata.summary) ??
          stringValue(args.path) ??
          stringValue(args.file_path) ??
          stringValue(input.text) ??
          "file",
        status: status === "unknown" ? "done" : status,
      },
      metadata,
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
    return summaryWithDetails(
      {
        verb: normalized,
        target:
          stringValue(metadata.path) ??
          stringValue(metadata.context) ??
          stringValue(metadata.summary) ??
          stringValue(args.path) ??
          stringValue(args.file_path) ??
          stringValue(input.text) ??
          "file",
        status: status === "unknown" ? "done" : status,
      },
      metadata,
      detail,
    );
  }
  if (normalized === "bash") {
    const exitCode = numberValue(metadata.exit_code);
    const effectiveStatus = exitCode === null ? status : exitCode === 0 ? "done" : "failed";
    return summaryWithDetails(
      {
        verb: "bash",
        target:
          stringValue(metadata.command) ??
          stringValue(metadata.context) ??
          stringValue(metadata.summary) ??
          stringValue(args.command) ??
          stringValue(input.text) ??
          "command",
        status: effectiveStatus,
      },
      metadata,
      effectiveStatus === "failed" ? durationDetail : exitCode === null ? durationDetail : `exit ${exitCode}`,
    );
  }
  if (normalized === "grep") {
    const matches = numberValue(metadata.matches);
    return summaryWithDetails(
      {
        verb: "grep",
        target:
          stringValue(metadata.query) ??
          stringValue(metadata.context) ??
          stringValue(metadata.summary) ??
          stringValue(args.query) ??
          stringValue(args.pattern) ??
          stringValue(input.text) ??
          "pattern",
        status: status === "unknown" ? "done" : status,
      },
      metadata,
      matches === null ? durationDetail : `${matches} matches`,
    );
  }
  return summaryWithDetails(
    {
      verb: normalized,
      target:
        stringValue(metadata.path) ??
        lifecycleTarget(metadata) ??
        stringValue(args.path) ??
        stringValue(args.file_path) ??
        stringValue(input.text) ??
        "tool call",
      status,
    },
    metadata,
    durationDetail,
  );
}
