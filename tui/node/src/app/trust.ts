import type { ShellState } from "../state/types.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function trustLabel(state: ShellState): string {
  const suffix = state.trust.enforced === false ? "*" : "";
  return `${state.trust.state}${suffix}`;
}

export function trustColor(state: ShellState, theme: ThemeTokens): string {
  if (state.trust.state === "trusted") {
    return theme.success;
  }
  if (state.trust.state === "untrusted") {
    return theme.warning;
  }
  return theme.subtle;
}

export function trustExplanation(state: ShellState): string {
  if (state.trust.enforced === false) {
    return "runtime enforcement pending";
  }
  if (state.trust.state === "trusted") {
    return "trusted workspace";
  }
  if (state.trust.state === "untrusted") {
    return "read-only/chat until trusted";
  }
  return "trust not decided";
}
