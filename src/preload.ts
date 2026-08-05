import { contextBridge, ipcRenderer } from "electron";

import type {
  AgentApprovalResponse,
  AgentEvent,
  AgentModel,
  AgentRunRequest,
  GeminiAccountUsage,
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

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  loadWorkspace: () =>
    ipcRenderer.invoke("workspace:load") as Promise<string | null>,
  saveWorkspace: (serialized: string) =>
    ipcRenderer.invoke("workspace:save", serialized) as Promise<void>,
  openDevTools: () => ipcRenderer.invoke("devtools:open") as Promise<void>,
  selectSourceFolder: () =>
    ipcRenderer.invoke("dialog:select-source-folder") as Promise<string | null>,
  revealProjectFolder: (sourceFolder: string) =>
    ipcRenderer.invoke(
      "project:reveal-source-folder",
      sourceFolder,
    ) as Promise<void>,
  createWorktree: (request: WorktreeCreateRequest) =>
    ipcRenderer.invoke("worktree:create", request) as Promise<SessionWorktree>,
  revealWorktree: (worktreePath: string) =>
    ipcRenderer.invoke("worktree:reveal", worktreePath) as Promise<void>,
  listAgentModels: () =>
    ipcRenderer.invoke("agent:models") as Promise<AgentModel[]>,
  getGeminiUsage: () =>
    ipcRenderer.invoke("agent:gemini-usage") as Promise<GeminiAccountUsage>,
  runAgent: (request: AgentRunRequest) =>
    ipcRenderer.invoke("agent:run", request) as Promise<void>,
  cancelAgent: (runId: string) =>
    ipcRenderer.invoke("agent:cancel", runId) as Promise<boolean>,
  respondToAgentApproval: (response: AgentApprovalResponse) =>
    ipcRenderer.invoke("agent:respond-approval", response) as Promise<boolean>,
  onAgentEvent: (callback: (event: AgentEvent) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: AgentEvent,
    ) => {
      callback(payload);
    };
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  listTerminals: (projectId: string) =>
    ipcRenderer.invoke("terminal:list", projectId) as Promise<TerminalTab[]>,
  createTerminal: (request: TerminalCreateRequest) =>
    ipcRenderer.invoke("terminal:create", request) as Promise<TerminalTab>,
  readTerminal: (request: TerminalTargetRequest) =>
    ipcRenderer.invoke(
      "terminal:read",
      request,
    ) as Promise<TerminalOutputSnapshot>,
  writeTerminal: (request: TerminalWriteRequest) =>
    ipcRenderer.send("terminal:write", request),
  resizeTerminal: (request: TerminalResizeRequest) =>
    ipcRenderer.send("terminal:resize", request),
  closeTerminal: (request: TerminalTargetRequest) =>
    ipcRenderer.invoke("terminal:close", request) as Promise<boolean>,
  onTerminalEvent: (callback: (event: TerminalEvent) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: TerminalEvent,
    ) => {
      callback(payload);
    };
    ipcRenderer.on("terminal:event", listener);
    return () => ipcRenderer.removeListener("terminal:event", listener);
  },
});
