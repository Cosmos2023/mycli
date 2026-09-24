# Bounded Subagent Reports Keep The Cut Visible

## Problem

A child agent's final report reached the parent through two paths that both stopped at a fixed
character cap without saying so. Live delivery cut the report at 32,768 characters inside
`deliverAgentCompletion`, and restart recovery cut it at 32,000 characters inside
`serializeSubagentTaskNotification`. Neither path told the model the report had been cut, and
neither named where the complete text lived, so a trimmed report read as the whole answer and
whatever the child wrote past the cap silently disappeared. Delivery also had no byte-level budget,
so a report whose encoded form exceeded the queue limit could be rejected outright.

## Change

`backend/packages/integrations/src/subagents/report-bounding.ts` adds `boundSubagentReport(value,
{ maxChars, maxBytes?, outputFile?, encodedLength? })`. It returns the value unchanged when it fits,
otherwise the longest leading prefix that still fits the character budget and, when given, the byte
budget, followed by a marker:

```
[report truncated: showing 12000 of 40000 characters. Full report: <artifact path>]
```

The prefix is chosen by binary search over code points, so truncation never splits a surrogate pair.
When the artifact path is unknown the marker reads `The remainder was dropped.` instead of naming a
file. If even the marker cannot fit the budget, the helper degrades to the largest fragment of the
marker that fits, and then to the largest fragment of the report, so a cut always stays visible.

Both delivery paths use it now:

- Live delivery (`backend/apps/mycli/src/node-runtime/node-backend.ts`) resolves the child's task
  output path from the session artifact store, passes it as `outputFile`, and bounds the report to
  `SUBAGENT_NOTIFICATION_MAX_BYTES - 4_096` bytes of JSON-encoded text, which leaves headroom for the
  steering envelope the queue wraps around it.
- Restart recovery (`backend/packages/integrations/src/subagents/task-notification.ts`) drops the
  `.slice()` and bounds the full result with the same helper, measuring bytes after XML escaping. The
  existing `escapeXmlWithinBytes` call stays as a last-resort backstop.
- `backend/packages/storage/src/agents/agent-mailbox-store.ts` exports
  `AGENT_MAILBOX_COMPLETION_REPORT_MAX_CHARS`, so a caller bounds a report to the same cap the
  repository enforces when it stores one. The repository still rejects a report above that cap.

## Verification

- `backend/packages/integrations/test/subagents/subagent-tools.test.ts` covers the marker with the
  artifact path, the byte budget, and the untouched short report.
- `backend/apps/mycli/test/node-backend.integration.test.ts` adds "delivers an oversized child report
  with a visible truncation marker", which runs a real turn and asserts the parent request carries
  both the marker and the artifact path.
- The full `node-backend.integration.test.ts` file passes 65/65. The integrations subagent suites,
  the runtime `agent-mailbox` and `agent-supervisor` suites, and the storage agent suites pass 46/46.
  ESLint, `npm run build`, and `npm run typecheck` pass.

## Notes

The token counter (`backend/packages/runtime/src/context/token-counter.ts`, `js-tiktoken`
`o200k_base`) scales badly on a long run of one repeated character: 1k characters take 76 ms, 4k take
903 ms, and 16k take about 14.5 s, while 63,704 characters of ordinary prose take 9 ms. That
pathology sits on the pre-existing delivery path, so it is reachable without this change; the
oversized-report integration test therefore uses prose instead of one repeated character. Fixing the
counter is a separate change.

## Deferred

Three related improvements stay out of scope: one shared envelope for both delivery paths, status
detail beyond the current terminal status, and marking the report as agent-sourced in the parent
transcript so compaction can budget it separately.