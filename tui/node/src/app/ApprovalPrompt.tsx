import React from "react";
import { Box, Text } from "ink";

export function ApprovalPrompt({
  pendingApproval,
}: {
  pendingApproval: Record<string, unknown> | null;
}) {
  if (!pendingApproval) {
    return null;
  }
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text color="yellow">Approval required</Text>
      <Text>{String(pendingApproval.preview ?? "")}</Text>
    </Box>
  );
}
