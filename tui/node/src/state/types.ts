import type { ThemeName, ThemeTokens } from "../theme/types.ts";
import type {
  ApprovalRequestPayload,
  ClarifyRequestPayload,
  WorkspaceTrustPayload,
} from "../protocol/types.ts";

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
  | "clarification"
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
  items: Array<{
    value: string;
    description?: string;
    kind?: string;
    category?: string;
    mutating?: boolean;
    aliases?: string[];
  }>;
  selectedIndex: number;
};

export type OverlayState = {
  visible: boolean;
  title: string;
  lines: string[];
  presentationHint?: string;
};

export type TurnLiveState =
  | "running"
  | "waiting_approval"
  | "waiting_clarification"
  | "completed"
  | "failed"
  | "interrupted"
  | "rejected";

export type LiveStatus = {
  client_turn_id?: string;
  state: TurnLiveState;
  kind: string;
  text: string;
  message?: string;
  severity?: string;
};

export type LiveReasoning = {
  client_turn_id?: string;
  kind: "reasoning" | "thinking";
  text: string;
};

export type ShellState = {
  sessionId: string | null;
  sessionTitle: string | null;
  workspace: string;
  model: string;
  provider: string;
  trust: WorkspaceTrustPayload;
  status: Record<string, unknown>;
  transcript: TranscriptItem[];
  themeName: ThemeName;
  theme: ThemeTokens;
  themeNotice: string | null;
  inputDraft: string;
  restoredDraft: string;
  turnRunning: boolean;
  currentTurnId: string | null;
  liveStatus: LiveStatus | null;
  liveReasoning: LiveReasoning | null;
  typedMessageTurnId: string | null;
  viewMode: ViewMode;
  completion: CompletionState;
  overlay: OverlayState;
  pendingApproval: ApprovalRequestPayload | null;
  pendingClarification: ClarifyRequestPayload | null;
};
