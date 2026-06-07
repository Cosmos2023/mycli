export type RuntimeCommandDispatch =
  | { kind: "command.run"; command: string }
  | { kind: "session.list" }
  | { kind: "session.resume"; sessionId: string }
  | { kind: "invalid"; command: string; lines: string[] };

export function runtimeCommandDispatch(raw: string): RuntimeCommandDispatch {
  const trimmed = raw.trim();
  const [name, ...rest] = trimmed.split(/\s+/);
  if (name === "/sessions") {
    return { kind: "session.list" };
  }
  if (name === "/resume") {
    const sessionId = rest.join(" ").trim();
    if (!sessionId) {
      return {
        kind: "invalid",
        command: trimmed,
        lines: ["Usage: /resume <session_id>", "Run /sessions to inspect resumable sessions."],
      };
    }
    return { kind: "session.resume", sessionId };
  }
  return { kind: "command.run", command: trimmed };
}

export function sessionListOverlayLines(payload: Record<string, unknown>): string[] {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (sessions.length === 0) {
    return ["No resumable sessions found."];
  }
  return sessions.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }
    const id = stringField(item, "id") || "unknown";
    const current = item.current === true ? "current" : "";
    const lastActive = stringField(item, "last_active") || "last-active unknown";
    const messageCount = numberField(item, "message_count");
    const messages = messageCount === null ? "messages unknown" : `${messageCount} messages`;
    const prefix = `${String(index + 1).padStart(2, " ")}.`;
    return [`${prefix} ${id} ${current}`.trimEnd(), `    ${lastActive} · ${messages}`];
  });
}

export function sessionResumeOverlayLines(payload: Record<string, unknown>): string[] {
  const sessionId = stringField(payload, "session_id") || "unknown";
  const lines = Array.isArray(payload.lines) ? payload.lines.map((line) => String(line)) : [];
  return [`Active session: ${sessionId}`, ...lines];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
