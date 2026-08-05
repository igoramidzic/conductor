import { contextBridge, ipcRenderer } from "electron";

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

contextBridge.exposeInMainWorld("electron", {
  platform: process.platform,
  selectSourceFolder: () =>
    ipcRenderer.invoke("dialog:select-source-folder") as Promise<string | null>,
  listAgentModels: () =>
    ipcRenderer.invoke("agent:models") as Promise<AgentModel[]>,
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
