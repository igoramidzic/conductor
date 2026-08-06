import type {
  AgentApprovalResponse,
  AgentEvent,
  AgentModel,
  AgentRunRequest,
  GeminiAccountUsage,
  ResponseLinkOpenRequest,
  SessionWorktree,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalOutputSnapshot,
  TerminalResizeRequest,
  TerminalTab,
  TerminalTargetRequest,
  TerminalWriteRequest,
  WorktreeCreateRequest,
} from "./types";

declare global {
  interface Window {
    electron: {
      platform: NodeJS.Platform;
      loadWorkspace: () => Promise<string | null>;
      saveWorkspace: (serialized: string) => Promise<void>;
      openDevTools: () => Promise<void>;
      selectSourceFolder: () => Promise<string | null>;
      revealProjectFolder: (sourceFolder: string) => Promise<void>;
      createWorktree: (
        request: WorktreeCreateRequest,
      ) => Promise<SessionWorktree>;
      revealWorktree: (worktreePath: string) => Promise<void>;
      openResponseLink: (request: ResponseLinkOpenRequest) => Promise<void>;
      listAgentModels: () => Promise<AgentModel[]>;
      getGeminiUsage: () => Promise<GeminiAccountUsage>;
      runAgent: (request: AgentRunRequest) => Promise<void>;
      cancelAgent: (runId: string) => Promise<boolean>;
      respondToAgentApproval: (
        response: AgentApprovalResponse,
      ) => Promise<boolean>;
      onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;
      listTerminals: (projectId: string) => Promise<TerminalTab[]>;
      createTerminal: (request: TerminalCreateRequest) => Promise<TerminalTab>;
      readTerminal: (
        request: TerminalTargetRequest,
      ) => Promise<TerminalOutputSnapshot>;
      writeTerminal: (request: TerminalWriteRequest) => void;
      resizeTerminal: (request: TerminalResizeRequest) => void;
      closeTerminal: (request: TerminalTargetRequest) => Promise<boolean>;
      onTerminalEvent: (callback: (event: TerminalEvent) => void) => () => void;
    };
  }
}
