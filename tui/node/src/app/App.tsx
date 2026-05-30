import React from "react";
import { Box } from "ink";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { CompletionPopup } from "./CompletionPopup.tsx";
import { Header } from "./Header.tsx";
import { InputBox } from "./InputBox.tsx";
import { Overlay } from "./Overlay.tsx";
import { RunningActivity } from "./RunningActivity.tsx";
import { statusMetadata } from "./StatusLine.tsx";
import { Transcript } from "./Transcript.tsx";
import { WelcomePanel } from "./WelcomePanel.tsx";
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import type { ShellAction } from "../state/reducer.ts";
import type { ShellState } from "../state/types.ts";

export function App({
  state,
  width = 80,
  onSubmit,
  onCommand,
  onLocalAction,
  onInterrupt,
  onDraftChange,
  onDecision,
}: {
  state: ShellState;
  width?: number;
  onSubmit?: (value: string) => void;
  onCommand?: (command: string) => void;
  onLocalAction?: (action: ShellAction) => void;
  onInterrupt?: () => void;
  onDraftChange?: (value: string) => void;
  onDecision?: (decisionId: string, choice: string) => void;
}) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Header state={state} width={width} />
      <WelcomePanel state={state} width={width} />
      <Transcript state={state} width={width} />
      <RunningActivity state={state} />
      <Overlay overlay={state.overlay} theme={state.theme} />
      <ApprovalPrompt
        pendingApproval={state.pendingApproval}
        theme={state.theme}
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
        metadata={statusMetadata(state)}
        width={width}
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
    </Box>
  );
}
