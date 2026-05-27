import React from "react";
import { Box } from "ink";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { InputBox } from "./InputBox.tsx";
import { Overlay } from "./Overlay.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { Transcript } from "./Transcript.tsx";
import type { ShellState } from "../state/types.ts";

export function App({
  state,
  onSubmit,
  onInterrupt,
  onDraftChange,
}: {
  state: ShellState;
  onSubmit?: (value: string) => void;
  onInterrupt?: () => void;
  onDraftChange?: (value: string) => void;
}) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Transcript state={state} />
      <Overlay overlay={state.overlay} />
      <ApprovalPrompt pendingApproval={state.pendingApproval} />
      <InputBox
        draft={state.inputDraft}
        turnRunning={state.turnRunning}
        completionVisible={state.completion.visible}
        onDraftChange={onDraftChange ?? (() => undefined)}
        onSubmit={onSubmit ?? (() => undefined)}
        onInterrupt={onInterrupt ?? (() => undefined)}
      />
      <StatusLine state={state} />
    </Box>
  );
}
