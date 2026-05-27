import React from "react";
import { Box } from "ink";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { CompletionPopup } from "./CompletionPopup.tsx";
import { InputBox } from "./InputBox.tsx";
import { Overlay } from "./Overlay.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { Transcript } from "./Transcript.tsx";
import type { ShellState } from "../state/types.ts";

export function App({
  state,
  onSubmit,
  onCommand,
  onInterrupt,
  onDraftChange,
  onDecision,
}: {
  state: ShellState;
  onSubmit?: (value: string) => void;
  onCommand?: (command: string) => void;
  onInterrupt?: () => void;
  onDraftChange?: (value: string) => void;
  onDecision?: (decisionId: string, choice: string) => void;
}) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Transcript state={state} />
      <Overlay overlay={state.overlay} />
      <ApprovalPrompt
        pendingApproval={state.pendingApproval}
        onDecision={onDecision ?? (() => undefined)}
      />
      <CompletionPopup
        visible={state.completion.visible}
        items={state.completion.items}
        selectedIndex={state.completion.selectedIndex}
      />
      <InputBox
        draft={state.inputDraft}
        turnRunning={state.turnRunning}
        completionVisible={state.completion.visible}
        onDraftChange={onDraftChange ?? (() => undefined)}
        onSubmit={(value) => {
          if (value.startsWith("/")) {
            onCommand?.(value);
            return;
          }
          onSubmit?.(value);
        }}
        onInterrupt={onInterrupt ?? (() => undefined)}
      />
      <StatusLine state={state} />
    </Box>
  );
}
