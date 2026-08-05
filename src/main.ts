import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  webContents,
} from "electron";
import started from "electron-squirrel-startup";
import * as pty from "node-pty";

import { getAgentAccessArgs, resolveAgentAccessMode } from "./agent-access";
import {
  type AgentApprovalRequest,
  type AgentApprovalResponse,
  type AgentEvent,
  type AgentModel,
  type AgentProvider,
  type AgentRunRequest,
  STANDALONE_TERMINAL_GROUP_ID,
  type TerminalCreateRequest,
  type TerminalEvent,
  type TerminalResizeRequest,
  type TerminalTab,
  type TerminalTargetRequest,
  type TerminalWriteRequest,
} from "./types";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

type CodexApprovalKind = "command" | "file-change";

type PendingCodexApproval = {
  requestId: string | number;
  kind: CodexApprovalKind;
  canApproveForSession: boolean;
};

type ActiveRun = {
  process: ChildProcessWithoutNullStreams;
  senderId: number;
  cancelled: boolean;
  pendingApprovals?: Map<string, PendingCodexApproval>;
};

const activeRuns = new Map<string, ActiveRun>();

type TerminalSession = {
  process: pty.IPty;
  tab: TerminalTab;
  output: string;
  sequence: number;
  closed: boolean;
};

type TerminalProject = {
  sourceFolder: string;
  terminals: Map<string, TerminalSession>;
  nextTabNumber: number;
};

const terminalProjects = new Map<number, Map<string, TerminalProject>>();
const TERMINAL_OUTPUT_LIMIT = 2_000_000;
const TERMINAL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

function assertTerminalId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !TERMINAL_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function assertTerminalSize(cols: unknown, rows: unknown) {
  if (
    typeof cols !== "number" ||
    !Number.isInteger(cols) ||
    cols < 2 ||
    cols > 500 ||
    typeof rows !== "number" ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 300
  ) {
    throw new Error("Invalid terminal size.");
  }
}

function getTerminalProject(senderId: number, projectId: string) {
  return terminalProjects.get(senderId)?.get(projectId);
}

function requireTerminalSession(
  senderId: number,
  request: TerminalTargetRequest,
) {
  assertTerminalId(request.projectId, "project identifier");
  assertTerminalId(request.terminalId, "terminal identifier");
  const terminal = getTerminalProject(
    senderId,
    request.projectId,
  )?.terminals.get(request.terminalId);
  if (!terminal) {
    throw new Error("Terminal session not found.");
  }
  return terminal;
}

function sendTerminalEvent(senderId: number, event: TerminalEvent) {
  const sender = webContents.fromId(senderId);
  if (sender && !sender.isDestroyed()) {
    sender.send("terminal:event", event);
  }
}

function terminalEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function createTerminalSession(
  senderId: number,
  request: TerminalCreateRequest,
): TerminalTab {
  assertTerminalId(request.projectId, "project identifier");
  assertTerminalSize(request.cols, request.rows);
  if (
    request.sourceFolder !== undefined &&
    (typeof request.sourceFolder !== "string" ||
      !path.isAbsolute(request.sourceFolder))
  ) {
    throw new Error("Invalid terminal directory.");
  }
  if (
    request.sourceFolder === undefined &&
    request.projectId !== STANDALONE_TERMINAL_GROUP_ID
  ) {
    throw new Error("A project terminal requires a source folder.");
  }

  const sourceFolder = path.resolve(
    request.sourceFolder ?? app.getPath("home"),
  );
  if (!fs.statSync(sourceFolder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("The terminal directory no longer exists.");
  }

  let projects = terminalProjects.get(senderId);
  if (!projects) {
    projects = new Map();
    terminalProjects.set(senderId, projects);
  }
  let project = projects.get(request.projectId);
  if (!project) {
    project = {
      sourceFolder,
      terminals: new Map(),
      nextTabNumber: 1,
    };
    projects.set(request.projectId, project);
  } else if (project.sourceFolder !== sourceFolder) {
    throw new Error("The project directory changed while terminals were open.");
  }

  const shell =
    process.platform === "win32"
      ? (process.env.COMSPEC ?? "powershell.exe")
      : (process.env.SHELL ??
        (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"));
  const tabNumber = project.nextTabNumber;
  project.nextTabNumber += 1;
  const shellName = path.basename(shell).replace(/\.exe$/i, "") || "Terminal";
  const tab: TerminalTab = {
    id: randomUUID(),
    title: tabNumber === 1 ? shellName : `${shellName} ${tabNumber}`,
    shell: shellName,
    status: "running",
  };

  const terminalProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: request.cols,
    rows: request.rows,
    cwd: sourceFolder,
    env: {
      ...terminalEnvironment(),
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    },
  });
  const terminal: TerminalSession = {
    process: terminalProcess,
    tab,
    output: "",
    sequence: 0,
    closed: false,
  };
  project.terminals.set(tab.id, terminal);

  terminalProcess.onData((data) => {
    if (terminal.closed) {
      return;
    }
    terminal.output = `${terminal.output}${data}`.slice(-TERMINAL_OUTPUT_LIMIT);
    terminal.sequence += 1;
    sendTerminalEvent(senderId, {
      projectId: request.projectId,
      terminalId: tab.id,
      type: "data",
      data,
      sequence: terminal.sequence,
    });
  });
  terminalProcess.onExit(({ exitCode }) => {
    if (terminal.closed) {
      return;
    }
    terminal.tab = {
      ...terminal.tab,
      status: "exited",
      exitCode,
    };
    sendTerminalEvent(senderId, {
      projectId: request.projectId,
      terminalId: tab.id,
      type: "exit",
      exitCode,
    });
  });

  return tab;
}

function closeTerminalSession(
  senderId: number,
  request: TerminalTargetRequest,
) {
  const terminal = requireTerminalSession(senderId, request);
  terminal.closed = true;
  getTerminalProject(senderId, request.projectId)?.terminals.delete(
    request.terminalId,
  );
  try {
    terminal.process.kill();
  } catch {
    // The shell may have already exited naturally.
  }
}

function disposeTerminalsForSender(senderId: number) {
  const projects = terminalProjects.get(senderId);
  terminalProjects.delete(senderId);
  for (const project of projects?.values() ?? []) {
    for (const terminal of project.terminals.values()) {
      terminal.closed = true;
      try {
        terminal.process.kill();
      } catch {
        // The shell may have already exited naturally.
      }
    }
  }
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,199}$/;

function sendAgentEvent(event: IpcMainInvokeEvent, payload: AgentEvent) {
  if (!event.sender.isDestroyed()) {
    event.sender.send("agent:event", payload);
  }
}

function sendAgentEventToSender(senderId: number, payload: AgentEvent) {
  const sender = webContents.fromId(senderId);
  if (sender && !sender.isDestroyed()) {
    sender.send("agent:event", payload);
  }
}

const AGENT_EXECUTABLES: Record<
  AgentProvider,
  { command: string; environmentVariable: string }
> = {
  agy: { command: "agy", environmentVariable: "AGY_PATH" },
  claude: { command: "claude", environmentVariable: "CLAUDE_PATH" },
  codex: { command: "codex", environmentVariable: "CODEX_PATH" },
};

function findAgentExecutable(provider: AgentProvider) {
  const definition = AGENT_EXECUTABLES[provider];
  const override = process.env[definition.environmentVariable];
  if (override) {
    return override;
  }

  const homeBinary = path.join(
    app.getPath("home"),
    ".local",
    "bin",
    definition.command,
  );
  if (fs.existsSync(homeBinary)) {
    return homeBinary;
  }

  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(
        directory,
        `${definition.command}${extension}`,
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function requireAgentExecutable(provider: AgentProvider) {
  const executable = findAgentExecutable(provider);
  if (!executable) {
    throw new Error(`${AGENT_EXECUTABLES[provider].command} is not installed.`);
  }
  return executable;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatRuntimeModelName(model: string) {
  const gemini = model.match(
    /^gemini-(\d+(?:\.\d+)?)-([a-z0-9]+)(?:-(high|medium|low))?$/i,
  );
  if (gemini) {
    const [, version, variant, effort] = gemini;
    return `Gemini ${version} ${capitalize(variant ?? "")}${
      effort ? ` · ${capitalize(effort)}` : ""
    }`;
  }

  return model
    .split("-")
    .map((part) => capitalize(part))
    .join(" ");
}

function readRuntimeModels() {
  const executable = findAgentExecutable("agy");
  if (!executable) {
    return Promise.resolve<AgentModel[]>([]);
  }

  return new Promise<AgentModel[]>((resolve, reject) => {
    const child = spawn(executable, ["models"], {
      env: process.env,
      stdio: "pipe",
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("Model discovery timed out.")));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => {
      finish(() =>
        reject(
          new Error(`Could not discover available models: ${error.message}`),
        ),
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(
            new Error(
              stderr.trim() ||
                `Model discovery exited with code ${code ?? "unknown"}.`,
            ),
          );
          return;
        }

        const models = stdout
          .split(/\r?\n/)
          .map((line) => line.trim().replace(/^[*-]\s+/, ""))
          .filter((line) => MODEL_ID_PATTERN.test(line))
          .filter((model, index, values) => values.indexOf(model) === index)
          .map((model) => ({
            provider: "agy" as const,
            model,
            label: formatRuntimeModelName(model),
            group: model.startsWith("gemini-") ? "Gemini" : "Other",
          }));
        resolve(models);
      });
    });
  });
}

function readClaudeModels(): AgentModel[] {
  if (!findAgentExecutable("claude")) {
    return [];
  }

  const models: AgentModel[] = [
    {
      provider: "claude",
      model: "fable",
      label: "Fable (latest)",
      group: "Claude",
    },
    {
      provider: "claude",
      model: "opus",
      label: "Opus (latest)",
      group: "Claude",
    },
    {
      provider: "claude",
      model: "sonnet",
      label: "Sonnet (latest)",
      group: "Claude",
    },
    {
      provider: "claude",
      model: "haiku",
      label: "Haiku (latest)",
      group: "Claude",
    },
  ];

  try {
    const configPath = path.join(app.getPath("home"), ".claude.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      additionalModelOptionsCache?: Array<{
        value?: unknown;
        label?: unknown;
      }>;
    };
    for (const option of config.additionalModelOptionsCache ?? []) {
      if (
        typeof option.value !== "string" ||
        !MODEL_ID_PATTERN.test(option.value) ||
        models.some((model) => model.model === option.value)
      ) {
        continue;
      }
      const baseLabel =
        typeof option.label === "string" ? option.label : option.value;
      models.push({
        provider: "claude",
        model: option.value,
        label: option.value.includes("[1m]") ? `${baseLabel} · 1M` : baseLabel,
        group: "Claude",
      });
    }
  } catch {
    // Claude's stable aliases remain available when the optional cache is absent.
  }

  return models;
}

function readCodexModels(): AgentModel[] {
  if (!findAgentExecutable("codex")) {
    return [];
  }

  try {
    const cachePath = path.join(
      app.getPath("home"),
      ".codex",
      "models_cache.json",
    );
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        visibility?: unknown;
      }>;
    };
    return (cache.models ?? [])
      .filter(
        (model) =>
          model.visibility === "list" &&
          typeof model.slug === "string" &&
          MODEL_ID_PATTERN.test(model.slug),
      )
      .map((model) => ({
        provider: "codex" as const,
        model: model.slug as string,
        label:
          typeof model.display_name === "string"
            ? model.display_name
            : (model.slug as string),
        group: "Codex",
      }));
  } catch {
    return [];
  }
}

let availableModelsPromise: Promise<AgentModel[]> | undefined;

function listAvailableModels() {
  if (!availableModelsPromise) {
    availableModelsPromise = readRuntimeModels()
      .catch(() => [])
      .then((runtimeModels) => [
        ...readCodexModels(),
        ...readClaudeModels(),
        ...runtimeModels.filter(
          (model) =>
            !(
              model.model.startsWith("claude-") && findAgentExecutable("claude")
            ),
        ),
      ]);
  }
  return availableModelsPromise;
}

function assertRunRequest(request: AgentRunRequest) {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid agent request.");
  }

  if (
    typeof request.runId !== "string" ||
    request.runId.length < 8 ||
    request.runId.length > 100
  ) {
    throw new Error("Invalid run identifier.");
  }

  if (
    typeof request.prompt !== "string" ||
    request.prompt.trim().length === 0 ||
    request.prompt.length > 100_000
  ) {
    throw new Error("The prompt is empty or too long.");
  }

  if (request.sourceFolder !== undefined) {
    if (
      typeof request.sourceFolder !== "string" ||
      !path.isAbsolute(request.sourceFolder)
    ) {
      throw new Error("Choose an absolute source folder.");
    }

    let folderStats: fs.Stats;
    try {
      folderStats = fs.statSync(request.sourceFolder);
    } catch {
      throw new Error("The source folder no longer exists.");
    }

    if (!folderStats.isDirectory()) {
      throw new Error("The selected source path is not a folder.");
    }
  }

  if (
    request.provider !== undefined &&
    !(["agy", "claude", "codex"] as const).includes(request.provider)
  ) {
    throw new Error("Invalid agent provider.");
  }

  if (
    request.model !== undefined &&
    (typeof request.model !== "string" || !MODEL_ID_PATTERN.test(request.model))
  ) {
    throw new Error("Invalid model identifier.");
  }

  const provider = request.provider ?? "agy";
  if (
    request.accessMode !== undefined &&
    (typeof request.accessMode !== "string" ||
      resolveAgentAccessMode(provider, request.accessMode) !==
        request.accessMode)
  ) {
    throw new Error("Invalid access mode for this agent provider.");
  }

  if (
    request.conversationId &&
    !/^[a-zA-Z0-9-]{8,100}$/.test(request.conversationId)
  ) {
    throw new Error("Invalid conversation identifier.");
  }
}

function assertApprovalResponse(
  response: AgentApprovalResponse,
): asserts response is AgentApprovalResponse {
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.runId !== "string" ||
    response.runId.length < 8 ||
    response.runId.length > 100 ||
    typeof response.approvalId !== "string" ||
    !/^[a-fA-F0-9-]{36}$/.test(response.approvalId) ||
    !(["approve", "approve-session", "deny"] as const).includes(
      response.decision,
    )
  ) {
    throw new Error("Invalid approval response.");
  }
}

type ParserState = {
  response: string;
  finished: boolean;
  stdoutLines: number;
  unparseableLines: number;
  eventCounts: Record<string, number>;
};

const DIAGNOSTIC_STRING_FIELDS = new Set([
  "event",
  "type",
  "subtype",
  "step_type",
  "state",
  "status",
]);

function summarizeStreamValue(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") {
    return DIAGNOSTIC_STRING_FIELDS.has(key)
      ? value
      : `<string:${value.length}>`;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return `<array:${value.length}>`;
  }
  if (typeof value !== "object") {
    return `<${typeof value}>`;
  }

  const record = value as Record<string, unknown>;
  if (depth >= 2) {
    return { keys: Object.keys(record) };
  }
  return Object.fromEntries(
    Object.entries(record).map(([entryKey, entryValue]) => [
      entryKey,
      summarizeStreamValue(entryValue, entryKey, depth + 1),
    ]),
  );
}

function logAgentStreamLine(
  request: AgentRunRequest,
  state: ParserState,
  line: string,
) {
  state.stdoutLines += 1;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    state.unparseableLines += 1;
    console.warn(`[agent:${request.runId}] Non-JSON stdout line.`, {
      line: state.stdoutLines,
      characters: line.length,
    });
    return;
  }

  const discriminator = [payload.event, payload.type, payload.method].find(
    (value) => typeof value === "string",
  );
  const eventName =
    typeof discriminator === "string" ? discriminator : "unknown";
  state.eventCounts[eventName] = (state.eventCounts[eventName] ?? 0) + 1;
  console.info(`[agent:${request.runId}] stdout event.`, {
    line: state.stdoutLines,
    event: eventName,
    shape: summarizeStreamValue(payload),
  });
}

function sendConversation(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  conversationId: string,
) {
  sendAgentEvent(event, {
    runId: request.runId,
    type: "conversation",
    conversationId,
    provider: request.provider ?? "agy",
  });
}

function sendDelta(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  text: string,
) {
  if (!text) {
    return;
  }
  state.response += text;
  sendAgentEvent(event, { runId: request.runId, type: "delta", text });
}

function sendComplete(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  response = state.response,
) {
  state.finished = true;
  sendAgentEvent(event, {
    runId: request.runId,
    type: "complete",
    response,
  });
}

function parseRuntimeLine(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  line: string,
) {
  if (!line.trim()) {
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (payload.event === "init") {
    const conversationId = payload.conversation_id;
    if (typeof conversationId === "string") {
      sendConversation(event, request, conversationId);
    }
    return;
  }

  if (payload.event === "step_update") {
    const update = payload.step_update as Record<string, unknown> | undefined;
    if (!update) {
      return;
    }

    const text = update.text_delta;
    if (typeof text === "string" && text.length > 0) {
      sendDelta(event, request, state, text);
      return;
    }

    const stepType =
      typeof update.step_type === "string" ? update.step_type : "working";
    const toolCall = update.tool_call as Record<string, unknown> | undefined;
    const tool = update.tool as Record<string, unknown> | undefined;
    const rawLabel = [
      update.tool_name,
      toolCall?.name,
      toolCall?.tool_name,
      tool?.name,
      update.name,
    ].find((value) => typeof value === "string") as string | undefined;
    const label = (rawLabel ?? stepType)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());

    sendAgentEvent(event, {
      runId: request.runId,
      type: "status",
      activityId: String(update.step_index ?? stepType),
      label,
      stepType,
      state: typeof update.state === "string" ? update.state : "RUNNING",
    });
    return;
  }

  if (payload.event === "result") {
    const result = payload.result as Record<string, unknown> | undefined;
    sendComplete(
      event,
      request,
      state,
      typeof result?.response === "string" ? result.response : state.response,
    );
  }
}

function parseClaudeLine(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  line: string,
) {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (payload.type === "system" && payload.subtype === "init") {
    if (typeof payload.session_id === "string") {
      sendConversation(event, request, payload.session_id);
    }
    return;
  }

  if (payload.type === "stream_event") {
    const streamEvent = payload.event as Record<string, unknown> | undefined;
    const delta = streamEvent?.delta as Record<string, unknown> | undefined;
    if (
      streamEvent?.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string"
    ) {
      sendDelta(event, request, state, delta.text);
      return;
    }
  }

  if (payload.type === "assistant") {
    const message = payload.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const entry = block as Record<string, unknown>;
      if (entry.type === "tool_use" && typeof entry.name === "string") {
        sendAgentEvent(event, {
          runId: request.runId,
          type: "status",
          activityId: String(entry.id ?? entry.name),
          label: entry.name.replace(/[_-]+/g, " "),
          stepType: "tool_use",
          state: "RUNNING",
        });
      }
    }
    return;
  }

  if (payload.type === "result") {
    if (payload.is_error === true) {
      state.finished = true;
      sendAgentEvent(event, {
        runId: request.runId,
        type: "error",
        message:
          typeof payload.result === "string"
            ? payload.result
            : "Claude stopped before finishing.",
      });
      return;
    }
    sendComplete(
      event,
      request,
      state,
      typeof payload.result === "string" ? payload.result : state.response,
    );
  }
}

function codexActivityLabel(item: Record<string, unknown>) {
  if (item.type === "command_execution" || item.type === "commandExecution") {
    return "Running command";
  }
  if (item.type === "file_change" || item.type === "fileChange") {
    return "Editing files";
  }
  if (item.type === "web_search" || item.type === "webSearch") {
    return "Searching the web";
  }
  if (item.type === "mcp_tool_call" || item.type === "mcpToolCall") {
    return typeof item.tool === "string" ? item.tool : "Using tool";
  }
  return typeof item.type === "string"
    ? item.type.replace(/[_-]+/g, " ")
    : "Working";
}

function parseCodexLine(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  line: string,
) {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (
    payload.type === "thread.started" &&
    typeof payload.thread_id === "string"
  ) {
    sendConversation(event, request, payload.thread_id);
    return;
  }

  if (payload.type === "item.started" || payload.type === "item.completed") {
    const item = payload.item as Record<string, unknown> | undefined;
    if (!item) {
      return;
    }

    if (item.type === "agent_message" && typeof item.text === "string") {
      if (
        payload.type === "item.completed" &&
        !state.response.endsWith(item.text)
      ) {
        sendDelta(event, request, state, item.text);
      }
      return;
    }

    if (item.type !== "reasoning") {
      sendAgentEvent(event, {
        runId: request.runId,
        type: "status",
        activityId: String(item.id ?? item.type ?? "working"),
        label: codexActivityLabel(item),
        stepType: typeof item.type === "string" ? item.type : "working",
        state: payload.type === "item.completed" ? "COMPLETED" : "RUNNING",
      });
    }
    return;
  }

  if (payload.type === "turn.completed") {
    sendComplete(event, request, state);
    return;
  }

  if (payload.type === "turn.failed" || payload.type === "error") {
    const error = payload.error as Record<string, unknown> | undefined;
    state.finished = true;
    sendAgentEvent(event, {
      runId: request.runId,
      type: "error",
      message:
        typeof error?.message === "string"
          ? error.message
          : "Codex stopped before finishing.",
    });
  }
}

type JsonRecord = Record<string, unknown>;

type PendingRpcRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as JsonRecord)
    : undefined;
}

function rpcErrorMessage(error: unknown) {
  const payload = asRecord(error);
  return typeof payload?.message === "string"
    ? payload.message
    : "Codex app-server rejected the request.";
}

function writeCodexProtocolMessage(
  child: ChildProcessWithoutNullStreams,
  message: JsonRecord,
) {
  return new Promise<void>((resolve, reject) => {
    if (child.stdin.destroyed || !child.stdin.writable) {
      reject(new Error("The Codex approval channel is no longer available."));
      return;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function codexFileChange(value: unknown) {
  const change = asRecord(value);
  const type = asRecord(change?.kind)?.type;
  if (
    typeof change?.path !== "string" ||
    !["add", "update", "delete"].includes(String(type))
  ) {
    return undefined;
  }
  return {
    path: change.path,
    change: type as "add" | "update" | "delete",
    diff:
      typeof change.diff === "string"
        ? change.diff.slice(0, 12_000)
        : undefined,
  };
}

function startCodexApprovalRun(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
) {
  const executable = requireAgentExecutable("codex");
  const child = spawn(executable, ["app-server", "--stdio"], {
    cwd: request.sourceFolder ?? app.getPath("home"),
    env: process.env,
    stdio: "pipe",
  });
  const activeRun: ActiveRun = {
    process: child,
    senderId: event.sender.id,
    cancelled: false,
    pendingApprovals: new Map(),
  };
  activeRuns.set(request.runId, activeRun);
  sendAgentEvent(event, { runId: request.runId, type: "started" });

  const parserState: ParserState = {
    response: "",
    finished: false,
    stdoutLines: 0,
    unparseableLines: 0,
    eventCounts: {},
  };
  const pendingRpcRequests = new Map<string | number, PendingRpcRequest>();
  const items = new Map<string, JsonRecord>();
  let nextRequestId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";

  const finishWithError = (message: string) => {
    if (parserState.finished || activeRun.cancelled) {
      return;
    }
    parserState.finished = true;
    sendAgentEventToSender(activeRun.senderId, {
      runId: request.runId,
      type: "error",
      message,
    });
  };

  const requestRpc = (method: string, params: JsonRecord) => {
    const id = `conductor:${request.runId}:${nextRequestId}`;
    nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      pendingRpcRequests.set(id, { resolve, reject });
      void writeCodexProtocolMessage(child, { method, id, params }).catch(
        (error: unknown) => {
          pendingRpcRequests.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  };

  const sendApproval = (
    protocolRequestId: string | number,
    params: JsonRecord,
    kind: CodexApprovalKind,
  ) => {
    const itemId = typeof params.itemId === "string" ? params.itemId : "";
    const item = items.get(itemId);
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : undefined;
    const approvalId = randomUUID();
    const canApproveForSession =
      kind === "file-change" ||
      availableDecisions === undefined ||
      availableDecisions.includes("acceptForSession");
    const approval: AgentApprovalRequest = {
      id: approvalId,
      kind,
      title:
        kind === "command"
          ? "Codex wants to run a command"
          : "Codex wants to edit files",
      reason: typeof params.reason === "string" ? params.reason : undefined,
      command:
        kind === "command" && typeof params.command === "string"
          ? params.command
          : undefined,
      cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      files:
        kind === "file-change" && Array.isArray(item?.changes)
          ? item.changes
              .map(codexFileChange)
              .filter((change) => change !== undefined)
          : undefined,
      canApproveForSession,
    };
    activeRun.pendingApprovals?.set(approvalId, {
      requestId: protocolRequestId,
      kind,
      canApproveForSession,
    });
    sendAgentEventToSender(activeRun.senderId, {
      runId: request.runId,
      type: "approval",
      approval,
    });
  };

  const handleMessage = (message: JsonRecord) => {
    const id = message.id;
    const method = message.method;
    if ((typeof id === "string" || typeof id === "number") && !method) {
      const pending = pendingRpcRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRpcRequests.delete(id);
      if (message.error !== undefined) {
        pending.reject(new Error(rpcErrorMessage(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (
      (typeof id === "string" || typeof id === "number") &&
      method === "item/commandExecution/requestApproval"
    ) {
      const params = asRecord(message.params);
      if (params) {
        sendApproval(id, params, "command");
      }
      return;
    }

    if (
      (typeof id === "string" || typeof id === "number") &&
      method === "item/fileChange/requestApproval"
    ) {
      const params = asRecord(message.params);
      if (params) {
        sendApproval(id, params, "file-change");
      }
      return;
    }

    if (typeof id === "string" || typeof id === "number") {
      void writeCodexProtocolMessage(child, {
        id,
        error: {
          code: -32601,
          message: `Conductor does not support ${String(method)} yet.`,
        },
      });
      return;
    }

    const params = asRecord(message.params);
    if (!params || typeof method !== "string") {
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (typeof params.delta === "string") {
        sendDelta(event, request, parserState, params.delta);
      }
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = asRecord(params.item);
      if (!item) {
        return;
      }
      if (typeof item.id === "string") {
        items.set(item.id, item);
      }
      if (
        item.type !== "reasoning" &&
        item.type !== "agentMessage" &&
        item.type !== "userMessage"
      ) {
        sendAgentEvent(event, {
          runId: request.runId,
          type: "status",
          activityId: String(item.id ?? item.type ?? "working"),
          label: codexActivityLabel(item),
          stepType: typeof item.type === "string" ? item.type : "working",
          state: method === "item/completed" ? "COMPLETED" : "RUNNING",
        });
      }
      return;
    }

    if (method === "error" && params.willRetry !== true) {
      finishWithError(rpcErrorMessage(asRecord(params.error)));
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (!parserState.finished) {
        if (turn?.status === "completed") {
          sendComplete(event, request, parserState);
        } else if (turn?.status === "interrupted" && activeRun.cancelled) {
          // The process close handler emits the cancellation event.
        } else {
          finishWithError(
            rpcErrorMessage(
              asRecord(turn?.error) ?? {
                message: "Codex stopped before finishing.",
              },
            ),
          );
        }
      }
      child.kill("SIGTERM");
    }
  };

  const parseLine = (line: string) => {
    if (!line.trim()) {
      return;
    }
    try {
      handleMessage(JSON.parse(line) as JsonRecord);
    } catch {
      // App-server stdout is JSONL; malformed diagnostics are ignored.
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      parseLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-8_000);
  });
  child.on("error", (error) => {
    finishWithError(`Could not start Codex: ${error.message}`);
  });
  child.on("close", (code) => {
    if (stdoutBuffer.trim()) {
      parseLine(stdoutBuffer);
    }
    for (const pending of pendingRpcRequests.values()) {
      pending.reject(new Error("The Codex app-server stopped."));
    }
    pendingRpcRequests.clear();
    if (activeRuns.get(request.runId) === activeRun) {
      activeRuns.delete(request.runId);
    }
    if (activeRun.cancelled) {
      sendAgentEventToSender(activeRun.senderId, {
        runId: request.runId,
        type: "cancelled",
      });
    } else if (!parserState.finished) {
      const details = stderrBuffer
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-4)
        .join("\n");
      finishWithError(
        details || `Codex app-server exited with code ${code ?? "unknown"}.`,
      );
    }
  });

  void (async () => {
    await requestRpc("initialize", {
      clientInfo: {
        name: "conductor",
        title: "Conductor",
        version: app.getVersion(),
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    await writeCodexProtocolMessage(child, { method: "initialized" });

    const cwd = request.sourceFolder ?? app.getPath("home");
    const access = {
      model: request.model ?? null,
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
    };
    const threadResult = asRecord(
      await requestRpc(
        request.conversationId ? "thread/resume" : "thread/start",
        request.conversationId
          ? { threadId: request.conversationId, ...access }
          : access,
      ),
    );
    const thread = asRecord(threadResult?.thread);
    if (typeof thread?.id !== "string") {
      throw new Error("Codex did not return a conversation identifier.");
    }
    sendConversation(event, request, thread.id);
    await requestRpc("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: request.prompt,
          text_elements: [],
        },
      ],
    });
  })().catch((error: unknown) => {
    finishWithError(
      error instanceof Error ? error.message : "Could not start Codex.",
    );
    child.kill("SIGTERM");
  });
}

function parseAgentLine(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  line: string,
) {
  logAgentStreamLine(request, state, line);
  const provider = request.provider ?? "agy";
  if (provider === "claude") {
    parseClaudeLine(event, request, state, line);
  } else if (provider === "codex") {
    parseCodexLine(event, request, state, line);
  } else {
    parseRuntimeLine(event, request, state, line);
  }
}

function createRunCommand(request: AgentRunRequest) {
  const provider = request.provider ?? "agy";
  const executable = requireAgentExecutable(provider);
  const accessArgs = getAgentAccessArgs(provider, request.accessMode);

  if (provider === "claude") {
    const args = [
      ...accessArgs,
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (request.model) {
      args.push("--model", request.model);
    }
    if (request.conversationId) {
      args.push("--resume", request.conversationId);
    }
    args.push(request.prompt);
    return { executable, args };
  }

  if (provider === "codex") {
    const args = request.conversationId
      ? [...accessArgs, "exec", "resume", "--json"]
      : [...accessArgs, "exec", "--json"];
    if (request.sourceFolder === undefined) {
      args.push("--skip-git-repo-check");
    }
    if (request.model) {
      args.push("--model", request.model);
    }
    if (request.conversationId) {
      args.push(request.conversationId);
    }
    args.push(request.prompt);
    return { executable, args };
  }

  const args = [...accessArgs, "--output-format", "stream-json"];
  if (request.model) {
    args.push("--model", request.model);
  }
  args.push("--print");
  if (request.conversationId) {
    args.push("--conversation", request.conversationId);
  }
  args.push(request.prompt);
  return { executable, args };
}

ipcMain.handle("dialog:select-source-folder", async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: "Choose a source folder",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);

  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("agent:models", () => listAvailableModels());

ipcMain.handle("agent:run", (event, request: AgentRunRequest) => {
  assertRunRequest(request);
  if (activeRuns.has(request.runId)) {
    throw new Error("This agent run is already active.");
  }

  if (
    (request.provider ?? "agy") === "codex" &&
    resolveAgentAccessMode("codex", request.accessMode) === "read-only"
  ) {
    startCodexApprovalRun(event, request);
    return;
  }

  const { executable, args } = createRunCommand(request);
  const provider = request.provider ?? "agy";
  const cwd = request.sourceFolder ?? app.getPath("home");
  const canAccessCwd = (mode: number) => {
    try {
      fs.accessSync(cwd, mode);
      return true;
    } catch {
      return false;
    }
  };
  console.info(`[agent:${request.runId}] Starting agent run.`, {
    provider,
    executable,
    cwd,
    cwdReadable: canAccessCwd(fs.constants.R_OK),
    cwdWritable: canAccessCwd(fs.constants.W_OK),
    model: request.model ?? null,
    accessMode: resolveAgentAccessMode(provider, request.accessMode),
    resumedConversation: Boolean(request.conversationId),
    promptCharacters: request.prompt.length,
    arguments: args
      .slice(0, -1)
      .map((argument, index, values) =>
        index > 0 && values[index - 1] === "--conversation"
          ? "<conversation-id>"
          : argument,
      ),
  });

  const child = spawn(executable, args, {
    cwd,
    env: process.env,
    stdio: "pipe",
  });
  child.stdin.end();
  const activeRun = {
    process: child,
    senderId: event.sender.id,
    cancelled: false,
  };
  activeRuns.set(request.runId, activeRun);
  sendAgentEvent(event, { runId: request.runId, type: "started" });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  const parserState: ParserState = {
    response: "",
    finished: false,
    stdoutLines: 0,
    unparseableLines: 0,
    eventCounts: {},
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      parseAgentLine(event, request, parserState, line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-8_000);
  });

  child.on("error", (error) => {
    console.error(`[agent:${request.runId}] Agent process failed to start.`, {
      message: error.message,
      executable,
      cwd,
    });
    activeRuns.delete(request.runId);
    parserState.finished = true;
    sendAgentEvent(event, {
      runId: request.runId,
      type: "error",
      message: `Could not start the agent: ${error.message}`,
    });
  });

  child.on("close", (code) => {
    if (stdoutBuffer.trim()) {
      parseAgentLine(event, request, parserState, stdoutBuffer);
    }

    activeRuns.delete(request.runId);
    console.info(`[agent:${request.runId}] Agent process closed.`, {
      provider,
      code,
      cancelled: activeRun.cancelled,
      parserFinished: parserState.finished,
      responseCharacters: parserState.response.length,
      stdoutLines: parserState.stdoutLines,
      unparseableLines: parserState.unparseableLines,
      eventCounts: parserState.eventCounts,
      trailingStderr: stderrBuffer.trim() || null,
    });
    if (activeRun.cancelled) {
      sendAgentEvent(event, { runId: request.runId, type: "cancelled" });
      return;
    }

    if (code !== 0 && !parserState.finished) {
      const details = stderrBuffer
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-4)
        .join("\n");
      sendAgentEvent(event, {
        runId: request.runId,
        type: "error",
        message: details || `The agent exited with code ${code ?? "unknown"}.`,
      });
    } else if (code === 0 && !parserState.finished) {
      console.warn(
        `[agent:${request.runId}] Process exited successfully without a recognized terminal result; completing with ${parserState.response.length} accumulated response characters.`,
      );
      sendComplete(event, request, parserState);
    }
  });
});

ipcMain.handle("agent:cancel", (event, runId: string) => {
  const run = activeRuns.get(runId);
  if (!run || run.senderId !== event.sender.id) {
    return false;
  }

  run.cancelled = true;
  return run.process.kill("SIGTERM");
});

ipcMain.handle(
  "agent:respond-approval",
  async (event, response: AgentApprovalResponse) => {
    assertApprovalResponse(response);
    const run = activeRuns.get(response.runId);
    if (!run || run.senderId !== event.sender.id) {
      return false;
    }
    const approval = run.pendingApprovals?.get(response.approvalId);
    if (!approval) {
      return false;
    }
    run.pendingApprovals?.delete(response.approvalId);

    const decision =
      response.decision === "deny"
        ? "decline"
        : response.decision === "approve-session" &&
            approval.canApproveForSession
          ? "acceptForSession"
          : "accept";
    try {
      await writeCodexProtocolMessage(run.process, {
        id: approval.requestId,
        result: { decision },
      });
    } catch (error) {
      run.pendingApprovals?.set(response.approvalId, approval);
      throw error;
    }
    sendAgentEventToSender(run.senderId, {
      runId: response.runId,
      type: "approval-resolved",
      approvalId: response.approvalId,
    });
    return true;
  },
);

ipcMain.handle("terminal:list", (event, projectId: string) => {
  assertTerminalId(projectId, "project identifier");
  const project = getTerminalProject(event.sender.id, projectId);
  return [...(project?.terminals.values() ?? [])].map(
    (terminal) => terminal.tab,
  );
});

ipcMain.handle("terminal:create", (event, request: TerminalCreateRequest) =>
  createTerminalSession(event.sender.id, request),
);

ipcMain.handle("terminal:read", (event, request: TerminalTargetRequest) => {
  const terminal = requireTerminalSession(event.sender.id, request);
  return {
    output: terminal.output,
    sequence: terminal.sequence,
  };
});

ipcMain.on("terminal:write", (event, request: TerminalWriteRequest) => {
  try {
    const terminal = requireTerminalSession(event.sender.id, request);
    if (
      terminal.tab.status !== "running" ||
      typeof request.data !== "string" ||
      request.data.length === 0 ||
      request.data.length > 65_536
    ) {
      return;
    }
    terminal.process.write(request.data);
  } catch {
    // The renderer may race a terminal closing; stale input can be ignored.
  }
});

ipcMain.on("terminal:resize", (event, request: TerminalResizeRequest) => {
  try {
    const terminal = requireTerminalSession(event.sender.id, request);
    assertTerminalSize(request.cols, request.rows);
    if (terminal.tab.status === "running") {
      terminal.process.resize(request.cols, request.rows);
    }
  } catch {
    // ResizeObserver can race tab/project changes; stale sizes can be ignored.
  }
});

ipcMain.handle("terminal:close", (event, request: TerminalTargetRequest) => {
  try {
    closeTerminalSession(event.sender.id, request);
    return true;
  } catch {
    return false;
  }
});

function createWindow() {
  const isMac = process.platform === "darwin";
  const mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#f8f9fb",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 17 } }
      : {
          titleBarOverlay: {
            color: "#f8f9fb",
            symbolColor: "#20242a",
            height: 48,
          },
        }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });

  const senderId = mainWindow.webContents.id;
  mainWindow.on("closed", () => {
    for (const [runId, run] of activeRuns) {
      if (run.senderId === senderId) {
        run.cancelled = true;
        run.process.kill("SIGTERM");
        activeRuns.delete(runId);
      }
    }
    disposeTerminalsForSender(senderId);
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
void app.whenReady().then(createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
