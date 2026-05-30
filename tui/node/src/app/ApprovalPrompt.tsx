import React from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

type ApprovalOption = { choice: string; label: string };

export function ApprovalPrompt({
  pendingApproval,
  theme,
  onDecision = () => undefined,
}: {
  pendingApproval: Record<string, unknown> | null;
  theme?: ThemeTokens;
  onDecision?: (decisionId: string, choice: string) => void;
}) {
  const options = (pendingApproval?.options as ApprovalOption[] | undefined) ?? [];
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
  const reason = typeof pendingApproval.reason === "string" ? pendingApproval.reason.trim() : "";
  const toolName =
    typeof pendingApproval.tool_name === "string" ? pendingApproval.tool_name.trim() : "";
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
