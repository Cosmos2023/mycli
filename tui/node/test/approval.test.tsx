import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { ApprovalPrompt } from "../src/app/ApprovalPrompt.tsx";

test("approval prompt renders choices", () => {
  const { lastFrame } = render(
    <ApprovalPrompt
      pendingApproval={{
        decision_id: "decision_current",
        preview: "git push",
        options: [{ choice: "approve_once", label: "Allow once" }],
      }}
    />,
  );

  const frame = lastFrame() ?? "";
  assert.match(frame, /git push/);
  assert.match(frame, /Allow once/);
});

test("approval prompt maps numeric key to option choice", () => {
  const resolved: Array<[string, string]> = [];
  const { stdin } = render(
    <ApprovalPrompt
      pendingApproval={{
        decision_id: "decision_current",
        preview: "git push",
        options: [
          { choice: "approve_once", label: "Allow once" },
          { choice: "reject", label: "Reject" },
        ],
      }}
      onDecision={(decisionId, choice) => resolved.push([decisionId, choice])}
    />,
  );

  stdin.write("1");

  assert.deepEqual(resolved, [["decision_current", "approve_once"]]);
});
