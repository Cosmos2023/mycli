import React from "react";
import { Box } from "ink";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { CompletionPopup } from "./CompletionPopup.tsx";
import { Header } from "./Header.tsx";
import { InputBox } from "./InputBox.tsx";
import { Overlay } from "./Overlay.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { Transcript } from "./Transcript.tsx";
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import type { ShellAction } from "../state/reducer.ts";
import type { ShellState } from "../state/types.ts";

export function App({
  state,
  onSubmit,
  onCommand,
  onLocalAction,
  onInterrupt,
  onDraftChange,
  onDecision,
}: {
  state: ShellState;
  onSubmit?: (value: string) => void;
  onCommand?: (command: string) => void;
  onLocalAction?: (action: ShellAction) => void;
  onInterrupt?: () => void;
  onDraftChange?: (value: string) => void;
  onDecision?: (decisionId: string, choice: string) => void;
}) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Header state={state} />
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
        theme={state.theme}
        onDraftChange={onDraftChange ?? (() => undefined)}
        onSubmit={(value) => {
          if (value.startsWith("/") && isLocalCommand(value)) {
            onLocalAction?.(handleLocalCommand(value, state));
            return;
          }
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
