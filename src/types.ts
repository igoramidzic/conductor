export type MessageRole = "user" | "assistant";

export type MessageStatus =
  | "complete"
  | "thinking"
  | "streaming"
  | "cancelled"
  | "error";

export type AgentActivityKind =
  | "reasoning"
  | "command"
  | "file-change"
  | "web-search"
  | "tool"
  | "other";

export type AgentActivity = {
  id: string;
  kind: AgentActivityKind;
  label: string;
  status: "running" | "complete" | "error";
  detail?: string;
  output?: string;
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

export type AgentReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type AgentSpeed = "standard" | "fast";

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
  contextWindow?: number;
  reasoningEfforts?: AgentReasoningEffort[];
  defaultReasoningEffort?: AgentReasoningEffort;
  speeds?: AgentSpeed[];
  defaultSpeed?: AgentSpeed;
};

export type AgentModelSelection = Pick<AgentModel, "provider" | "model"> & {
  reasoningEffort?: AgentReasoningEffort;
  speed?: AgentSpeed;
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  chunks: string[];
  createdAt: number;
  status: MessageStatus;
  activities: AgentActivity[];
  completedAt?: number;
  runId?: string;
  approval?: AgentApprovalRequest;
};

export type SessionExecutionMode = "local" | "worktree";

export type SessionWorktree = {
  name: string;
  path: string;
  workingDirectory: string;
  branch: string;
  baseRef: string;
  createdAt: number;
};

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  usedTokens: number;
  contextWindow?: number;
  processedTokens?: number;
};

export type GeminiQuotaModelUsage = {
  name: string;
  usedPercent: number;
  remainingPercent: number;
  resetLabel?: string;
};

export type GeminiQuotaSnapshot = {
  period: "daily";
  tier?: string;
  authMethod?: string;
  limit?: number;
  used?: number;
  remaining?: number;
  usedPercent?: number;
  resetLabel?: string;
  models: GeminiQuotaModelUsage[];
};

export type GeminiTokenTotals = {
  periodStart: string;
  periodEnd: string;
  total: number;
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  modelCalls: number;
  sessions: number;
};

export type GeminiAccountUsage = {
  provider: "gemini";
  measuredAt: string;
  tokens: GeminiTokenTotals;
  quota: GeminiQuotaSnapshot;
  quotaError?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  archived: boolean;
  hasUnreadCompletion: boolean;
  executionMode?: SessionExecutionMode;
  worktree?: SessionWorktree;
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  speed?: AgentSpeed;
  conversationId?: string;
  conversationProvider?: AgentProvider;
  usage?: AgentUsage;
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

export type WorktreeCreateRequest = {
  sessionId: string;
  sourceFolder: string;
  name: string;
};

export type AgentRunRequest = {
  runId: string;
  prompt: string;
  sourceFolder?: string;
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  speed?: AgentSpeed;
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
      kind?: AgentActivityKind;
      detail?: string;
      output?: string;
      stepType: string;
      state: string;
    }
  | {
      runId: string;
      type: "activity-delta";
      activityId: string;
      kind: AgentActivityKind;
      label?: string;
      field: "detail" | "output";
      text: string;
    }
  | { runId: string; type: "approval"; approval: AgentApprovalRequest }
  | { runId: string; type: "approval-resolved"; approvalId: string }
  | { runId: string; type: "usage"; usage: AgentUsage }
  | { runId: string; type: "delta"; text: string }
  | { runId: string; type: "complete"; response: string }
  | { runId: string; type: "cancelled" }
  | { runId: string; type: "error"; message: string };
