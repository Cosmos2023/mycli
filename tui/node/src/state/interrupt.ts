import type { ShellState } from "./types.ts";

export type InterruptIntent = "close_overlay" | "clear_input" | "interrupt_turn" | "exit";

export function interruptIntent(state: ShellState): InterruptIntent {
  if (state.overlay.visible || state.completion.visible) {
    return "close_overlay";
  }
  if (state.turnRunning) {
    return "interrupt_turn";
  }
  if (state.inputDraft.trim()) {
    return "clear_input";
  }
  return "exit";
}
