export type MessageRole = "user" | "assistant";

export type MessageStatus =
  | "complete"
  | "thinking"
  | "streaming"
  | "cancelled"
  | "error";

export type AgentActivity = {
  id: string;
  label: string;
  status: "running" | "complete";
};

export type AgentApprovalRequest = {
  id: string;
  kind: "command" | "file-change";
  title: string;
  reason?: string;
  command?: string;
  cwd?: string;
  files?: Array<{
    path: string;
    change: "add" | "update" | "delete";
    diff?: string;
  }>;
  canApproveForSession: boolean;
};

export type AgentApprovalDecision = "approve" | "approve-session" | "deny";

export type AgentApprovalResponse = {
  runId: string;
  approvalId: string;
  decision: AgentApprovalDecision;
};

export type AgentProvider = "gemini" | "claude" | "codex";

export type AgentAccessMode =
  | "ask"
  | "read-only"
  | "accept-edits"
  | "plan"
  | "auto"
  | "full-access";

export type AgentAccessPreferences = Partial<
  Record<AgentProvider, AgentAccessMode>
>;

export type AgentModel = {
  provider: AgentProvider;
  model: string;
  label: string;
  group: string;
};

export type AgentModelSelection = Pick<AgentModel, "provider" | "model">;

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  chunks: string[];
  createdAt: number;
  status: MessageStatus;
  activities: AgentActivity[];
  runId?: string;
  approval?: AgentApprovalRequest;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  archived: boolean;
  provider?: AgentProvider;
  model?: string;
  conversationId?: string;
  conversationProvider?: AgentProvider;
  messages: ChatMessage[];
};

export type Project = {
  id: string;
  name: string;
  sourceFolder: string;
  expanded: boolean;
  sessions: ChatSession[];
};

export type WorkspaceState = {
  recentChatsExpanded: boolean;
  recentChats: ChatSession[];
  projectsExpanded: boolean;
  projects: Project[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  lastModel?: AgentModelSelection;
  accessModes?: AgentAccessPreferences;
};

export const STANDALONE_TERMINAL_GROUP_ID = "standalone";

export type TerminalTab = {
  id: string;
  title: string;
  shell: string;
  status: "running" | "exited";
  exitCode?: number;
};

export type TerminalCreateRequest = {
  projectId: string;
  sourceFolder?: string;
  cols: number;
  rows: number;
};

export type TerminalTargetRequest = {
  projectId: string;
  terminalId: string;
};

export type TerminalWriteRequest = TerminalTargetRequest & {
  data: string;
};

export type TerminalResizeRequest = TerminalTargetRequest & {
  cols: number;
  rows: number;
};

export type TerminalOutputSnapshot = {
  output: string;
  sequence: number;
};

export type TerminalEvent =
  | {
      projectId: string;
      terminalId: string;
      type: "data";
      data: string;
      sequence: number;
    }
  | {
      projectId: string;
      terminalId: string;
      type: "exit";
      exitCode: number;
    };

export type AgentRunRequest = {
  runId: string;
  prompt: string;
  sourceFolder?: string;
  provider?: AgentProvider;
  model?: string;
  accessMode?: AgentAccessMode;
  conversationId?: string;
};

export type AgentEvent =
  | { runId: string; type: "started" }
  | {
      runId: string;
      type: "conversation";
      conversationId: string;
      provider: AgentProvider;
    }
  | {
      runId: string;
      type: "status";
      activityId: string;
      label: string;
      stepType: string;
      state: string;
    }
  | { runId: string; type: "approval"; approval: AgentApprovalRequest }
  | { runId: string; type: "approval-resolved"; approvalId: string }
  | { runId: string; type: "delta"; text: string }
  | { runId: string; type: "complete"; response: string }
  | { runId: string; type: "cancelled" }
  | { runId: string; type: "error"; message: string };
