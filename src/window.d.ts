import type {
  AgentApprovalResponse,
  AgentEvent,
  AgentModel,
  AgentRunRequest,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalOutputSnapshot,
  TerminalResizeRequest,
  TerminalTab,
  TerminalTargetRequest,
  TerminalWriteRequest,
} from "./types";

declare global {
  interface Window {
    electron: {
      platform: NodeJS.Platform;
      selectSourceFolder: () => Promise<string | null>;
      listAgentModels: () => Promise<AgentModel[]>;
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
