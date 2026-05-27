import React from "react";
import { Box, Text, useInput } from "ink";

type ApprovalOption = { choice: string; label: string };

export function ApprovalPrompt({
  pendingApproval,
  onDecision = () => undefined,
}: {
  pendingApproval: Record<string, unknown> | null;
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
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text color="yellow">Approval required</Text>
      <Text>{String(pendingApproval.preview ?? "")}</Text>
      {options.map((option, index) => (
        <Text key={option.choice}>
          {index + 1}. {option.label}
        </Text>
      ))}
    </Box>
  );
}
