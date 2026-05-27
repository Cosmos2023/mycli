import type { ThemeName, ThemeTokens } from "../theme/types.ts";

export type ViewMode = "default" | "verbose" | "focus";

export type TranscriptItemType =
  | "user"
  | "assistant_stream"
  | "assistant_final"
  | "execution_status"
  | "tool_summary"
  | "tool_detail"
  | "command_output"
  | "warning"
  | "error"
  | "approval"
  | "system_notice";

export type TranscriptItem = {
  id: string;
  type: TranscriptItemType;
  text: string;
  folded: boolean;
  metadata: Record<string, unknown>;
};

export type CompletionState = {
  visible: boolean;
  requestId: number;
  prefix: string;
  items: Array<{ value: string; description?: string; kind?: string }>;
  selectedIndex: number;
};

export type OverlayState = {
  visible: boolean;
  title: string;
  lines: string[];
};

export type ShellState = {
  sessionId: string | null;
  workspace: string;
  model: string;
  provider: string;
  status: Record<string, unknown>;
  transcript: TranscriptItem[];
  themeName: ThemeName;
  theme: ThemeTokens;
  themeNotice: string | null;
  inputDraft: string;
  restoredDraft: string;
  turnRunning: boolean;
  currentTurnId: string | null;
  viewMode: ViewMode;
  completion: CompletionState;
  overlay: OverlayState;
  pendingApproval: Record<string, unknown> | null;
};
