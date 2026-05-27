import React from "react";
import { Box } from "ink";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { Overlay } from "./Overlay.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { Transcript } from "./Transcript.tsx";
import type { ShellState } from "../state/types.ts";

export function App({ state }: { state: ShellState }) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Transcript state={state} />
      <Overlay overlay={state.overlay} />
      <ApprovalPrompt pendingApproval={state.pendingApproval} />
      <StatusLine state={state} />
    </Box>
  );
}
