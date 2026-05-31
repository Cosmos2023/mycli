import React from "react";
import { Box, Text, useInput } from "ink";
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
  const titleColor = theme?.warning ?? "yellow";
  const mutedColor = theme?.muted ?? "gray";
  const accentColor = theme?.accent ?? "cyan";
  const reason = pendingApproval.reason?.trim() ?? "";
  const toolName = pendingApproval.tool_name?.trim() ?? "";
  return (
    <Box
      borderColor={titleColor}
      borderStyle="round"
      flexDirection="column"
      paddingX={1}
      paddingY={0}
    >
      <Text color={titleColor} bold>
        Approval required
        {toolName ? <Text color={mutedColor}> · {toolName}</Text> : null}
      </Text>
      <Text>{String(pendingApproval.preview ?? "")}</Text>
      {reason ? <Text color={mutedColor}>Reason: {reason}</Text> : null}
      {options.map((option, index) => (
        <Text key={option.choice}>
          <Text color={accentColor}>{index + 1}</Text>
          <Text color={mutedColor}>. </Text>
          {option.label}
        </Text>
      ))}
      <Text color={mutedColor}>Press a number to respond.</Text>
    </Box>
  );
}
