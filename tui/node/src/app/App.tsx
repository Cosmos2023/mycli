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
import { TrustPrompt } from "./TrustPrompt.tsx";
import { WelcomePanel } from "./WelcomePanel.tsx";
import { interruptIntent } from "../state/interrupt.ts";
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import { slashCommandByName, slashCommandSuggestions } from "../state/slashCatalog.ts";
import type { ApprovalDecisionChoice, TrustStateValue } from "../protocol/types.ts";
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
  onClarification,
  onExit,
  onTrustChoice,
}: {
  state: ShellState;
  width?: number;
  onSubmit?: (value: string) => void;
  onCommand?: (command: string) => void;
  onLocalAction?: (action: ShellAction) => void;
  onInterrupt?: () => void;
  onDraftChange?: (value: string) => void;
  onDecision?: (decisionId: string, choice: ApprovalDecisionChoice) => void;
  onClarification?: (requestId: string, response: string) => void;
  onExit?: () => void;
  onTrustChoice?: (choice: TrustStateValue | "later") => void;
}) {
  const localAction = onLocalAction ?? (() => undefined);
  const handleInterrupt = (): void => {
    const intent = interruptIntent(state);
    if (intent === "close_overlay") {
      localAction({ type: "overlay.closed", message: "Cancelled." });
      return;
    }
    if (intent === "clear_input") {
      localAction({ type: "input.cleared" });
      onDraftChange?.("");
      return;
    }
    if (intent === "interrupt_turn") {
      onInterrupt?.();
      return;
    }
    onExit?.();
  };

  return (
    <Box flexDirection="column" minHeight={10}>
      <Header state={state} width={width} />
      <WelcomePanel state={state} width={width} />
      <Transcript state={state} width={width} />
      <RunningActivity state={state} />
      <Overlay overlay={state.overlay} theme={state.theme} />
      {state.overlay.visible ? null : (
        <TrustPrompt
          state={state}
          {...(onTrustChoice ? { onTrustChoice } : {})}
        />
      )}
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
        overlayVisible={state.overlay.visible}
        theme={state.theme}
        metadata={statusMetadata(state)}
        hint={inputHint(state)}
        width={width}
        onDraftChange={(value) => {
          localAction({ type: "input.changed", value });
          onDraftChange?.(value);
        }}
        onSubmit={(value) => {
          if (value.startsWith("/") && isLocalCommand(value)) {
            onLocalAction?.(handleLocalCommand(value, state));
            return;
          }
          if (value.startsWith("/")) {
            if (!slashCommandByName(value)) {
              const suggestions = slashCommandSuggestions(value);
              onLocalAction?.({
                type: "command.result",
                command: value,
                result: {
                  presentation: "overlay",
                  lines: [
                    `Unknown command: ${value}`,
                    ...(suggestions.length
                      ? ["", "Did you mean?", ...suggestions.map((command) => `  ${command.name} ${command.description}`)]
                      : ["", "Type /help to see available commands."]),
                  ],
                },
              });
              return;
            }
            onCommand?.(value);
            return;
          }
          const pendingClarification = state.pendingClarification;
          const requestId = clarificationRequestId(pendingClarification);
          if (pendingClarification && requestId) {
            onClarification?.(requestId, clarificationResponseFromInput(pendingClarification, value));
            return;
          }
          onSubmit?.(value);
        }}
        onInterrupt={handleInterrupt}
        onCompletionMove={(delta) => localAction({ type: "completion.move", delta })}
        onCompletionAccept={() => localAction({ type: "completion.accept" })}
        onCompletionClose={() => localAction({ type: "completion.closed" })}
      />
    </Box>
  );
}

function clarificationRequestId(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }
  const requestId = payload.request_id;
  return typeof requestId === "string" && requestId.trim() ? requestId : null;
}

export function inputHint(state: ShellState): string {
  if (state.completion.visible) {
    return "↑/↓ move · Tab accept · Esc cancel";
  }
  if (state.pendingApproval) {
    return "Press 1-9 to respond · Ctrl-C interrupt";
  }
  if (state.pendingClarification) {
    return "Type a reply · Enter send · / for commands";
  }
  if (state.turnRunning) {
    return "Running · Ctrl-C interrupt";
  }
  return "Enter send · / commands · Ctrl-C interrupt";
}

function clarificationResponseFromInput(payload: Record<string, unknown>, value: string): string {
  const options = clarificationOptions(payload);
  if (options.length === 0 || payload.multi_select === true) {
    return value;
  }
  const trimmed = value.trim();
  const numericChoice = Number.parseInt(trimmed, 10);
  if (String(numericChoice) === trimmed && numericChoice >= 1 && numericChoice <= options.length) {
    return options[numericChoice - 1] ?? value;
  }
  const matchingOption = options.find((option) => option.toLowerCase() === trimmed.toLowerCase());
  return matchingOption ?? value;
}

function clarificationOptions(payload: Record<string, unknown>): string[] {
  const options = payload.options;
  if (!Array.isArray(options)) {
    return [];
  }
  return options.flatMap((option) => {
    if (typeof option !== "object" || option === null || Array.isArray(option)) {
      return [];
    }
    const label = (option as Record<string, unknown>).label;
    return typeof label === "string" && label.trim() ? [label.trim()] : [];
  });
}
