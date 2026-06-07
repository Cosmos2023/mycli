import React from "react";
import { Text, useInput } from "ink";
import { Panel } from "./ui/Panel.tsx";
import { trustExplanation, trustLabel } from "./trust.ts";
import type { TrustStateValue } from "../protocol/types.ts";
import type { ShellState } from "../state/types.ts";

export function TrustPrompt({
  state,
  onTrustChoice = () => undefined,
}: {
  state: ShellState;
  onTrustChoice?: (choice: TrustStateValue | "later") => void;
}) {
  const show = state.trust.state !== "trusted";
  useInput(
    (input) => {
      if (!show) {
        return;
      }
      if (input === "1") {
        onTrustChoice("trusted");
      } else if (input === "2") {
        onTrustChoice("untrusted");
      } else if (input === "3") {
        onTrustChoice("later");
      }
    },
    { isActive: show },
  );

  if (!show) {
    return null;
  }

  return (
    <Panel
      title="Workspace trust"
      subtitle={trustExplanation(state)}
      theme={state.theme}
      borderColor={state.theme.warning}
      footer="1 Trust workspace · 2 Keep read-only · 3 Decide later"
      compact
    >
      <Text color={state.theme.text}>Do you trust this folder?</Text>
      <Text color={state.theme.muted}>{state.trust.workspace || state.workspace || "workspace pending"}</Text>
      <Text color={state.theme.subtle}>
        Current: {trustLabel(state)}. Untrusted workspaces should stay read-only/chat until runtime
        enforcement is available.
      </Text>
    </Panel>
  );
}
