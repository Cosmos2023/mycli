import React from "react";
import { Box, Text, useInput } from "ink";
import { Badge } from "./ui/Badge.tsx";
import { Panel } from "./ui/Panel.tsx";
import type { ThemeTokens } from "../theme/types.ts";
import type { ApprovalDecisionChoice, ApprovalRequestPayload } from "../protocol/types.ts";

export function ApprovalPrompt({
  pendingApproval,
  theme,
  onDecision = () => undefined,
}: {
  pendingApproval: ApprovalRequestPayload | null;
  theme?: ThemeTokens;
  onDecision?: (decisionId: string, choice: ApprovalDecisionChoice) => void;
}) {
  const options = pendingApproval?.options ?? [];
  useInput(
    (input) => {
      if (!pendingApproval) {
        return;
      }
      const index = Number.parseInt(input, 10) - 1;
      const option = options[index];
      if (option) {
        onDecision(String(pendingApproval.decision_id), option.choice);
      }
    },
    { isActive: pendingApproval !== null },
  );
  if (!pendingApproval) {
    return null;
  }
  const resolvedTheme = theme ?? {
    background: "black",
    surface: "black",
    surfaceRaised: "black",
    border: "gray",
    text: "white",
    muted: "gray",
    subtle: "gray",
    accent: "cyan",
    success: "green",
    warning: "yellow",
    error: "red",
    code: "cyan",
  };
  const reason = pendingApproval.reason?.trim() ?? "";
  const toolName = pendingApproval.tool_name?.trim() ?? "";
  const action = pendingApproval.action?.trim() || toolName || "runtime action";
  const cwd = pendingApproval.cwd?.trim() ?? "";
  const risk = pendingApproval.risk?.trim() ?? "";
  const riskReason = pendingApproval.risk_reason?.trim() ?? "";
  return (
    <Panel
      title="Approval required"
      subtitle={toolName ? `tool: ${toolName}` : "runtime policy needs a decision"}
      theme={resolvedTheme}
      borderColor={resolvedTheme.warning}
      footer="Press a number to respond."
    >
      <Box>
        <Badge variant="warning" theme={resolvedTheme}>
          hold
        </Badge>
        <Text color={resolvedTheme.text}> {String(pendingApproval.preview ?? "")}</Text>
      </Box>
      <Text color={resolvedTheme.subtle}>Decision: {pendingApproval.decision_id}</Text>
      <Text color={resolvedTheme.muted}>Action: {action}</Text>
      {cwd ? <Text color={resolvedTheme.muted}>Cwd: {cwd}</Text> : null}
      {risk ? <Text color={resolvedTheme.muted}>Risk: {risk}</Text> : null}
      {riskReason && riskReason !== reason ? (
        <Text color={resolvedTheme.muted}>Risk reason: {riskReason}</Text>
      ) : null}
      {reason ? <Text color={resolvedTheme.muted}>Reason: {reason}</Text> : null}
      {options.map((option, index) => (
        <Text key={option.choice}>
          <Text color={resolvedTheme.accent}>{index + 1}</Text>
          <Text color={resolvedTheme.muted}>. </Text>
          {option.label}
        </Text>
      ))}
    </Panel>
  );
}
