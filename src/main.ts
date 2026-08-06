import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  shell,
  webContents,
} from "electron";
import started from "electron-squirrel-startup";
import * as pty from "node-pty";

import { getAgentAccessArgs, resolveAgentAccessMode } from "./agent-access";
import { readRecordedGeminiUsage } from "./gemini-context-usage";
import { getGeminiAccountUsage } from "./gemini-usage";
import {
  classifyResponseLink,
  resolveResponseFilePath,
} from "./response-links";
import {
  type AgentActivityKind,
  type AgentApprovalRequest,
  type AgentApprovalResponse,
  type AgentEvent,
  type AgentModel,
  type AgentProvider,
  type AgentReasoningEffort,
  type AgentRunRequest,
  type AgentSpeed,
  type AgentUsage,
  type ResponseLinkOpenRequest,
  type SessionWorktree,
  STANDALONE_TERMINAL_GROUP_ID,
  type TerminalCreateRequest,
  type TerminalEvent,
  type TerminalResizeRequest,
  type TerminalTab,
  type TerminalTargetRequest,
  type TerminalWriteRequest,
  type WorktreeCreateRequest,
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
const WORKTREE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const WORKSPACE_FILE_NAME = "workspace.v1.json";
const WORKSPACE_FILE_SIZE_LIMIT = 100 * 1024 * 1024;
let workspaceWriteQueue = Promise.resolve();

function workspaceFilePath() {
  return path.join(app.getPath("userData"), WORKSPACE_FILE_NAME);
}

function assertWorkspacePayload(serialized: string) {
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") > WORKSPACE_FILE_SIZE_LIMIT
  ) {
    throw new Error("The workspace data is too large to save.");
  }

  const parsed = JSON.parse(serialized) as {
    projects?: unknown;
    recentChats?: unknown;
  };
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.projects) ||
    !Array.isArray(parsed.recentChats)
  ) {
    throw new Error("The workspace data is invalid.");
  }
}

async function readWorkspaceFile() {
  try {
    const serialized = await fs.promises.readFile(workspaceFilePath(), "utf8");
    assertWorkspacePayload(serialized);
    return serialized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeWorkspaceFile(serialized: string) {
  assertWorkspacePayload(serialized);
  const filePath = workspaceFilePath();
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.promises.writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true });
    throw error;
  }
}

function runGit(args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 2_000_000 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function worktreeStorageRoot() {
  return path.join(app.getPath("home"), ".conductor", "worktrees");
}

function pathIsInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function createSessionWorktree(
  request: WorktreeCreateRequest,
): Promise<SessionWorktree> {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid worktree request.");
  }
  assertTerminalId(request.sessionId, "session identifier");
  if (
    typeof request.sourceFolder !== "string" ||
    !path.isAbsolute(request.sourceFolder)
  ) {
    throw new Error("Choose an absolute project folder.");
  }
  if (
    typeof request.name !== "string" ||
    !WORKTREE_NAME_PATTERN.test(request.name)
  ) {
    throw new Error("Invalid worktree name.");
  }

  const requestedSourceFolder = path.resolve(request.sourceFolder);
  if (
    !fs
      .statSync(requestedSourceFolder, { throwIfNoEntry: false })
      ?.isDirectory()
  ) {
    throw new Error("The project folder no longer exists.");
  }
  const sourceFolder = fs.realpathSync(requestedSourceFolder);

  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(
      path.resolve(
        await runGit(["rev-parse", "--show-toplevel"], sourceFolder),
      ),
    );
  } catch {
    throw new Error("Worktrees require a Git repository.");
  }

  const relativeSourceFolder = path.relative(repoRoot, sourceFolder);
  if (
    relativeSourceFolder === ".." ||
    relativeSourceFolder.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSourceFolder)
  ) {
    throw new Error("The project folder is outside its Git repository.");
  }

  const sessionDirectory = path.join(worktreeStorageRoot(), request.sessionId);
  const worktreePath = path.join(sessionDirectory, path.basename(repoRoot));
  if (fs.existsSync(worktreePath)) {
    throw new Error("A worktree already exists for this session.");
  }

  const commit = await runGit(["rev-parse", "HEAD"], repoRoot);
  const currentRef = await runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot,
  );
  const baseRef =
    currentRef === "HEAD"
      ? await runGit(["rev-parse", "--short", "HEAD"], repoRoot)
      : currentRef;
  const branch = `conductor/${request.name}-${request.sessionId.slice(0, 8)}`;

  fs.mkdirSync(sessionDirectory, { recursive: true });
  try {
    await runGit(
      ["worktree", "add", "-b", branch, worktreePath, commit],
      repoRoot,
    );
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not create the worktree: ${error.message}`
        : "Could not create the worktree.",
    );
  }

  return {
    name: request.name,
    path: worktreePath,
    workingDirectory: path.join(worktreePath, relativeSourceFolder),
    branch,
    baseRef,
    createdAt: Date.now(),
  };
}

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
const GEMINI_CONTEXT_WINDOW = 1_048_576;
const CLAUDE_CONTEXT_WINDOW = 200_000;

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
  gemini: { command: "gemini", environmentVariable: "GEMINI_PATH" },
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

function readGeminiModels(): AgentModel[] {
  const executable = findAgentExecutable("gemini");
  if (!executable) {
    return [];
  }

  return [
    {
      provider: "gemini",
      model: "auto",
      label: "Auto",
      group: "Gemini",
      contextWindow: GEMINI_CONTEXT_WINDOW,
      speeds: ["standard"],
    },
    {
      provider: "gemini",
      model: "pro",
      label: "Pro",
      group: "Gemini",
      contextWindow: GEMINI_CONTEXT_WINDOW,
      speeds: ["standard"],
    },
    {
      provider: "gemini",
      model: "flash",
      label: "Flash",
      group: "Gemini",
      contextWindow: GEMINI_CONTEXT_WINDOW,
      speeds: ["standard"],
    },
    {
      provider: "gemini",
      model: "flash-lite",
      label: "Flash Lite",
      group: "Gemini",
      contextWindow: GEMINI_CONTEXT_WINDOW,
      speeds: ["standard"],
    },
  ];
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
      contextWindow: CLAUDE_CONTEXT_WINDOW,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      speeds: ["standard"],
    },
    {
      provider: "claude",
      model: "opus",
      label: "Opus (latest)",
      group: "Claude",
      contextWindow: CLAUDE_CONTEXT_WINDOW,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      speeds: ["standard"],
    },
    {
      provider: "claude",
      model: "sonnet",
      label: "Sonnet (latest)",
      group: "Claude",
      contextWindow: CLAUDE_CONTEXT_WINDOW,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      speeds: ["standard"],
    },
    {
      provider: "claude",
      model: "haiku",
      label: "Haiku (latest)",
      group: "Claude",
      contextWindow: CLAUDE_CONTEXT_WINDOW,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
      speeds: ["standard"],
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
        contextWindow: option.value.includes("[1m]")
          ? 1_000_000
          : CLAUDE_CONTEXT_WINDOW,
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "medium",
        speeds: ["standard"],
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
    const configPath = path.join(app.getPath("home"), ".codex", "config.toml");
    const config = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : "";
    const configuredModel = config.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1];
    const configuredReasoningEffort = config.match(
      /^model_reasoning_effort\s*=\s*["']([^"']+)["']/m,
    )?.[1];
    const configuredServiceTier = config.match(
      /^service_tier\s*=\s*["']([^"']+)["']/m,
    )?.[1];
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
        context_window?: unknown;
        effective_context_window_percent?: unknown;
        default_reasoning_level?: unknown;
        supported_reasoning_levels?: Array<{
          effort?: unknown;
        }>;
        additional_speed_tiers?: unknown;
        service_tiers?: Array<{
          id?: unknown;
        }>;
      }>;
    };
    const reasoningEfforts = new Set<AgentReasoningEffort>([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    return (cache.models ?? [])
      .filter(
        (model) =>
          model.visibility === "list" &&
          typeof model.slug === "string" &&
          MODEL_ID_PATTERN.test(model.slug),
      )
      .map((model) => {
        const supportedReasoningEfforts = (
          model.supported_reasoning_levels ?? []
        )
          .map((level) => level.effort)
          .filter(
            (effort): effort is AgentReasoningEffort =>
              typeof effort === "string" &&
              reasoningEfforts.has(effort as AgentReasoningEffort),
          );
        const catalogDefaultReasoningEffort =
          typeof model.default_reasoning_level === "string" &&
          reasoningEfforts.has(
            model.default_reasoning_level as AgentReasoningEffort,
          )
            ? (model.default_reasoning_level as AgentReasoningEffort)
            : supportedReasoningEfforts[0];
        const defaultReasoningEffort =
          model.slug === configuredModel &&
          typeof configuredReasoningEffort === "string" &&
          reasoningEfforts.has(
            configuredReasoningEffort as AgentReasoningEffort,
          ) &&
          supportedReasoningEfforts.includes(
            configuredReasoningEffort as AgentReasoningEffort,
          )
            ? (configuredReasoningEffort as AgentReasoningEffort)
            : catalogDefaultReasoningEffort;
        const hasFastSpeed =
          (Array.isArray(model.additional_speed_tiers) &&
            model.additional_speed_tiers.includes("fast")) ||
          (model.service_tiers ?? []).some((tier) => tier.id === "priority");

        return {
          provider: "codex" as const,
          model: model.slug as string,
          label:
            typeof model.display_name === "string"
              ? model.display_name
              : (model.slug as string),
          group: "Codex",
          contextWindow:
            typeof model.context_window === "number" &&
            Number.isFinite(model.context_window) &&
            model.context_window > 0
              ? Math.floor(
                  model.context_window *
                    (typeof model.effective_context_window_percent ===
                      "number" &&
                    Number.isFinite(model.effective_context_window_percent)
                      ? model.effective_context_window_percent / 100
                      : 1),
                )
              : undefined,
          reasoningEfforts: supportedReasoningEfforts,
          defaultReasoningEffort,
          speeds: hasFastSpeed
            ? (["standard", "fast"] satisfies AgentSpeed[])
            : (["standard"] satisfies AgentSpeed[]),
          defaultSpeed:
            model.slug === configuredModel &&
            hasFastSpeed &&
            configuredServiceTier === "priority"
              ? "fast"
              : "standard",
        };
      });
  } catch {
    return [];
  }
}

let availableModelsPromise: Promise<AgentModel[]> | undefined;

function listAvailableModels() {
  if (!availableModelsPromise) {
    availableModelsPromise = Promise.resolve([
      ...readGeminiModels(),
      ...readCodexModels(),
      ...readClaudeModels(),
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
    !(["gemini", "claude", "codex"] as const).includes(request.provider)
  ) {
    throw new Error("Invalid agent provider.");
  }

  if (
    request.model !== undefined &&
    (typeof request.model !== "string" || !MODEL_ID_PATTERN.test(request.model))
  ) {
    throw new Error("Invalid model identifier.");
  }

  const reasoningEfforts = new Set<AgentReasoningEffort>([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  if (
    request.reasoningEffort !== undefined &&
    !reasoningEfforts.has(request.reasoningEffort)
  ) {
    throw new Error("Invalid reasoning effort.");
  }
  if (
    request.speed !== undefined &&
    !new Set<AgentSpeed>(["standard", "fast"]).has(request.speed)
  ) {
    throw new Error("Invalid response speed.");
  }

  const provider = request.provider ?? "gemini";
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
  conversationId?: string;
  lastError?: string;
  model?: string;
  usage?: AgentUsage;
  activityLabels: Map<string, string>;
  activityIdsByIndex: Map<number, string>;
  textPartIdsByIndex: Map<number, string>;
  nextTextPartSequence: number;
  stdoutLines: number;
  unparseableLines: number;
  eventCounts: Record<string, number>;
};

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
    provider: request.provider ?? "gemini",
  });
}

function sendDelta(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  text: string,
  partId?: string,
) {
  if (!text) {
    return;
  }
  state.response += text;
  sendAgentEvent(event, {
    runId: request.runId,
    type: "delta",
    text,
    partId,
  });
}

function sendTextStart(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  partId: string,
) {
  sendAgentEvent(event, {
    runId: request.runId,
    type: "text-start",
    partId,
  });
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

function tokenCount(record: JsonRecord | undefined, ...fields: string[]) {
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

function requestContextWindow(request: AgentRunRequest) {
  const provider = request.provider ?? "gemini";
  if (provider === "gemini") {
    return GEMINI_CONTEXT_WINDOW;
  }
  if (provider === "claude") {
    return request.model?.includes("[1m]") ? 1_000_000 : CLAUDE_CONTEXT_WINDOW;
  }
  return readCodexModels().find((model) => model.model === request.model)
    ?.contextWindow;
}

function sendUsage(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  usage: Partial<AgentUsage>,
) {
  const inputTokens = usage.inputTokens ?? state.usage?.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? state.usage?.outputTokens ?? 0;
  const nextUsage: AgentUsage = {
    inputTokens,
    outputTokens,
    cachedInputTokens:
      usage.cachedInputTokens ?? state.usage?.cachedInputTokens ?? 0,
    usedTokens: usage.usedTokens ?? inputTokens + outputTokens,
    contextWindow:
      usage.contextWindow ??
      state.usage?.contextWindow ??
      requestContextWindow(request),
    processedTokens: usage.processedTokens ?? state.usage?.processedTokens,
  };
  state.usage = nextUsage;
  sendAgentEvent(event, {
    runId: request.runId,
    type: "usage",
    usage: nextUsage,
  });
}

function sendRecordUsage(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  usage: JsonRecord | undefined,
  contextWindow?: number,
  processedTokens?: number,
) {
  if (!usage) {
    return;
  }
  const inputTokens = tokenCount(usage, "inputTokens", "input_tokens");
  const outputTokens = tokenCount(usage, "outputTokens", "output_tokens");
  const cachedInputTokens = tokenCount(
    usage,
    "cachedInputTokens",
    "cached_input_tokens",
  );
  const usedTokens = tokenCount(usage, "totalTokens", "total_tokens");
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    usedTokens === undefined
  ) {
    return;
  }
  sendUsage(event, request, state, {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    usedTokens,
    contextWindow,
    processedTokens,
  });
}

function humanizeToolName(value: string) {
  return value
    .replace(/^mcp__[^_]+__/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatActivityValue(value: unknown, maxLength = 6_000) {
  if (value === undefined || value === null) {
    return undefined;
  }
  let formatted: string;
  if (typeof value === "string") {
    formatted = value;
  } else {
    try {
      formatted = JSON.stringify(value, null, 2);
    } catch {
      formatted = String(value);
    }
  }
  if (!formatted.trim()) {
    return undefined;
  }
  return formatted.length > maxLength
    ? `${formatted.slice(0, maxLength)}\n…`
    : formatted;
}

function sendActivity(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  activity: {
    id: string;
    kind: AgentActivityKind;
    label: string;
    stepType: string;
    status: string;
    detail?: string;
    output?: string;
  },
) {
  state.activityLabels.set(activity.id, activity.label);
  sendAgentEvent(event, {
    runId: request.runId,
    type: "status",
    activityId: activity.id,
    kind: activity.kind,
    label: activity.label,
    detail: activity.detail,
    output: activity.output,
    stepType: activity.stepType,
    state: activity.status,
  });
}

function sendActivityDelta(
  event: IpcMainInvokeEvent,
  request: AgentRunRequest,
  state: ParserState,
  activity: {
    id: string;
    kind: AgentActivityKind;
    label?: string;
    field: "detail" | "output";
    text: string;
  },
) {
  if (!activity.text) {
    return;
  }
  const label = activity.label ?? state.activityLabels.get(activity.id);
  if (label) {
    state.activityLabels.set(activity.id, label);
  }
  sendAgentEvent(event, {
    runId: request.runId,
    type: "activity-delta",
    activityId: activity.id,
    kind: activity.kind,
    label,
    field: activity.field,
    text: activity.text,
  });
}

function parseGeminiLine(
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

  if (payload.type === "init") {
    const conversationId = payload.session_id;
    if (typeof conversationId === "string") {
      state.conversationId = conversationId;
      sendConversation(event, request, conversationId);
    }
    return;
  }

  if (payload.type === "session_update" && typeof payload.model === "string") {
    state.model = payload.model;
    return;
  }

  if (
    payload.type === "message" &&
    (payload.role === "assistant" || payload.role === "agent")
  ) {
    if (typeof payload.content === "string") {
      sendDelta(event, request, state, payload.content);
      return;
    }
    for (const part of Array.isArray(payload.content) ? payload.content : []) {
      const content = asRecord(part);
      if (content?.type === "text" && typeof content.text === "string") {
        sendDelta(event, request, state, content.text);
      } else if (
        content?.type === "thought" &&
        typeof content.thought === "string"
      ) {
        sendActivity(event, request, state, {
          id: String(payload.id ?? "reasoning"),
          kind: "reasoning",
          label: "Thought through the request",
          detail: content.thought,
          stepType: "reasoning",
          status: "COMPLETED",
        });
      }
    }
    return;
  }

  if (
    (payload.type === "tool_use" || payload.type === "tool_request") &&
    typeof (payload.tool_name ?? payload.name) === "string"
  ) {
    const toolName = String(payload.tool_name ?? payload.name);
    sendActivity(event, request, state, {
      id: String(payload.tool_id ?? payload.requestId ?? toolName),
      kind: "tool",
      label: humanizeToolName(toolName),
      detail: formatActivityValue(
        payload.parameters ??
          payload.input ??
          payload.arguments ??
          payload.args,
      ),
      stepType: "tool_use",
      status: "RUNNING",
    });
    return;
  }

  if (payload.type === "tool_result" || payload.type === "tool_response") {
    const activityId = String(payload.tool_id ?? payload.requestId ?? "tool");
    sendActivity(event, request, state, {
      id: activityId,
      kind: "tool",
      label:
        state.activityLabels.get(activityId) ??
        (typeof payload.name === "string"
          ? humanizeToolName(payload.name)
          : "Used tool"),
      output: formatActivityValue(
        payload.output ?? payload.result ?? payload.content ?? payload.data,
      ),
      stepType: "tool_use",
      status:
        payload.isError === true || payload.status === "error"
          ? "ERROR"
          : "COMPLETED",
    });
    return;
  }

  if (payload.type === "usage") {
    const inputTokens = tokenCount(payload, "inputTokens", "input_tokens");
    const outputTokens = tokenCount(payload, "outputTokens", "output_tokens");
    const cachedInputTokens = tokenCount(
      payload,
      "cachedTokens",
      "cachedInputTokens",
      "cached_input_tokens",
    );
    if (inputTokens === undefined) {
      return;
    }
    // Gemini reports the current model call here. Replacing the previous
    // values lets an automatic context compaction reduce the displayed usage.
    sendUsage(event, request, state, {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      usedTokens: inputTokens,
      contextWindow: GEMINI_CONTEXT_WINDOW,
    });
    return;
  }

  if (
    (payload.type === "thought" || payload.type === "reasoning") &&
    typeof (payload.content ?? payload.text) === "string"
  ) {
    const text = String(payload.content ?? payload.text);
    sendActivity(event, request, state, {
      id: String(payload.id ?? "reasoning"),
      kind: "reasoning",
      label: "Thought through the request",
      detail: text,
      stepType: "reasoning",
      status: "COMPLETED",
    });
    return;
  }

  if (payload.type === "error" && typeof payload.message === "string") {
    state.lastError = payload.message;
    return;
  }

  if (payload.type === "result") {
    if (String(payload.status).toLowerCase() === "error") {
      const error = payload.error as Record<string, unknown> | undefined;
      state.finished = true;
      sendAgentEvent(event, {
        runId: request.runId,
        type: "error",
        message:
          typeof error?.message === "string"
            ? error.message
            : (state.lastError ?? "Gemini stopped before finishing."),
      });
      return;
    }
    if (!state.usage && state.conversationId) {
      // Stable Gemini CLI releases only expose cumulative session totals in
      // result.stats. The latest recorded model message has the current prompt
      // size, including the lower value after an automatic compaction.
      const recordedUsage = readRecordedGeminiUsage(
        process.env.GEMINI_CLI_HOME ?? app.getPath("home"),
        request.sourceFolder ?? app.getPath("home"),
        state.conversationId,
        GEMINI_CONTEXT_WINDOW,
      );
      if (recordedUsage) {
        sendUsage(event, request, state, recordedUsage);
      }
    }
    sendComplete(event, request, state);
    return;
  }

  if (payload.type === "agent_end" && payload.reason === "completed") {
    sendComplete(event, request, state);
  }
}

function claudeUsageFields(usage: JsonRecord | undefined) {
  if (!usage) {
    return undefined;
  }
  const uncachedInput = tokenCount(usage, "input_tokens", "inputTokens") ?? 0;
  const cacheCreation = tokenCount(usage, "cache_creation_input_tokens") ?? 0;
  const cacheRead = tokenCount(usage, "cache_read_input_tokens") ?? 0;
  return {
    inputTokens: uncachedInput + cacheCreation + cacheRead,
    outputTokens: tokenCount(usage, "output_tokens", "outputTokens") ?? 0,
    cachedInputTokens: cacheCreation + cacheRead,
  };
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
    const contentBlock = streamEvent?.content_block as
      | Record<string, unknown>
      | undefined;
    const index =
      typeof streamEvent?.index === "number" ? streamEvent.index : undefined;
    if (streamEvent?.type === "message_start") {
      state.activityIdsByIndex.clear();
      state.textPartIdsByIndex.clear();
      const message = asRecord(streamEvent.message);
      if (typeof message?.model === "string") {
        state.model = message.model;
      }
      const usage = claudeUsageFields(asRecord(message?.usage));
      if (usage) {
        sendUsage(event, request, state, {
          ...usage,
          usedTokens: usage.inputTokens + usage.outputTokens,
        });
      }
      return;
    }
    if (streamEvent?.type === "message_delta") {
      const outputTokens = tokenCount(
        asRecord(streamEvent.usage),
        "output_tokens",
        "outputTokens",
      );
      if (outputTokens !== undefined) {
        sendUsage(event, request, state, { outputTokens });
      }
      return;
    }
    if (
      streamEvent?.type === "content_block_delta" &&
      delta?.type === "text_delta" &&
      typeof delta.text === "string"
    ) {
      sendDelta(
        event,
        request,
        state,
        delta.text,
        index !== undefined ? state.textPartIdsByIndex.get(index) : undefined,
      );
      return;
    }
    if (streamEvent?.type === "content_block_start" && contentBlock) {
      if (contentBlock.type === "text") {
        const textPartId = `claude-text-${state.nextTextPartSequence}`;
        state.nextTextPartSequence += 1;
        if (index !== undefined) {
          state.textPartIdsByIndex.set(index, textPartId);
        }
        sendTextStart(event, request, textPartId);
        return;
      }
      const activityId = String(
        contentBlock.id ??
          (contentBlock.type === "thinking"
            ? `reasoning-${index ?? 0}`
            : `activity-${index ?? 0}`),
      );
      if (index !== undefined) {
        state.activityIdsByIndex.set(index, activityId);
      }
      if (contentBlock.type === "thinking") {
        sendActivity(event, request, state, {
          id: activityId,
          kind: "reasoning",
          label: "Thinking",
          stepType: "reasoning",
          status: "RUNNING",
        });
      } else if (
        contentBlock.type === "tool_use" &&
        typeof contentBlock.name === "string"
      ) {
        sendActivity(event, request, state, {
          id: activityId,
          kind: "tool",
          label: humanizeToolName(contentBlock.name),
          detail: formatActivityValue(contentBlock.input),
          stepType: "tool_use",
          status: "RUNNING",
        });
      }
      return;
    }
    if (
      streamEvent?.type === "content_block_delta" &&
      delta?.type === "thinking_delta" &&
      typeof delta.thinking === "string"
    ) {
      const activityId =
        (index !== undefined
          ? state.activityIdsByIndex.get(index)
          : undefined) ?? `reasoning-${index ?? 0}`;
      sendActivityDelta(event, request, state, {
        id: activityId,
        kind: "reasoning",
        label: "Thinking",
        field: "detail",
        text: delta.thinking,
      });
      return;
    }
    if (
      streamEvent?.type === "content_block_delta" &&
      delta?.type === "input_json_delta" &&
      typeof delta.partial_json === "string"
    ) {
      const activityId =
        (index !== undefined
          ? state.activityIdsByIndex.get(index)
          : undefined) ?? `activity-${index ?? 0}`;
      sendActivityDelta(event, request, state, {
        id: activityId,
        kind: "tool",
        field: "detail",
        text: delta.partial_json,
      });
      return;
    }
    if (streamEvent?.type === "content_block_stop" && index !== undefined) {
      const activityId = state.activityIdsByIndex.get(index);
      if (
        activityId &&
        state.activityLabels.get(activityId)?.toLowerCase() === "thinking"
      ) {
        sendActivity(event, request, state, {
          id: activityId,
          kind: "reasoning",
          label: "Thought through the request",
          stepType: "reasoning",
          status: "COMPLETED",
        });
      }
      return;
    }
  }

  if (payload.type === "assistant") {
    const message = payload.message as Record<string, unknown> | undefined;
    if (typeof message?.model === "string") {
      state.model = message.model;
    }
    const usage = claudeUsageFields(asRecord(message?.usage));
    if (usage) {
      sendUsage(event, request, state, {
        ...usage,
        usedTokens: usage.inputTokens + usage.outputTokens,
      });
    }
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const [index, block] of content.entries()) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const entry = block as Record<string, unknown>;
      if (entry.type === "thinking" && typeof entry.thinking === "string") {
        sendActivity(event, request, state, {
          id: String(
            entry.id ??
              state.activityIdsByIndex.get(index) ??
              `reasoning-${index}`,
          ),
          kind: "reasoning",
          label: "Thought through the request",
          detail: entry.thinking,
          stepType: "reasoning",
          status: "COMPLETED",
        });
      } else if (entry.type === "tool_use" && typeof entry.name === "string") {
        sendActivity(event, request, state, {
          id: String(entry.id ?? entry.name),
          kind: "tool",
          label: humanizeToolName(entry.name),
          detail: formatActivityValue(entry.input),
          stepType: "tool_use",
          status: "RUNNING",
        });
      }
    }
    return;
  }

  if (payload.type === "user") {
    const message = payload.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const entry = block as Record<string, unknown>;
      if (entry.type !== "tool_result") {
        continue;
      }
      const activityId = String(entry.tool_use_id ?? "tool");
      sendActivity(event, request, state, {
        id: activityId,
        kind: "tool",
        label: state.activityLabels.get(activityId) ?? "Used tool",
        output: formatActivityValue(entry.content),
        stepType: "tool_use",
        status: entry.is_error === true ? "ERROR" : "COMPLETED",
      });
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
    const modelUsage = asRecord(payload.modelUsage);
    const exactModelUsage = state.model
      ? asRecord(modelUsage?.[state.model])
      : undefined;
    const fallbackModelUsage = Object.values(modelUsage ?? {})
      .map(asRecord)
      .find((usage) => usage !== undefined);
    const contextWindow = tokenCount(
      exactModelUsage ?? fallbackModelUsage,
      "contextWindow",
      "context_window",
    );
    if (contextWindow !== undefined) {
      sendUsage(event, request, state, { contextWindow });
    } else if (!state.usage) {
      const usage = claudeUsageFields(asRecord(payload.usage));
      if (usage) {
        sendUsage(event, request, state, {
          ...usage,
          usedTokens: usage.inputTokens + usage.outputTokens,
        });
      }
    }
    sendComplete(
      event,
      request,
      state,
      typeof payload.result === "string" ? payload.result : state.response,
    );
  }
}

type CodexActivityDescriptor = {
  kind: AgentActivityKind;
  label: string;
  stepType: string;
  detail?: string;
  output?: string;
};

function codexItemType(item: JsonRecord) {
  return String(item.type ?? "working")
    .replace(/_/g, "")
    .toLowerCase();
}

function codexReasoningSummary(item: JsonRecord) {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const text = summary
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      const record = asRecord(part);
      return typeof record?.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return text || (typeof item.text === "string" ? item.text : undefined);
}

function codexReasoningPresentation(item: JsonRecord) {
  const summary = codexReasoningSummary(item);
  if (!summary) {
    return { label: "Thinking", detail: undefined };
  }
  const lines = summary.split("\n");
  const firstLineIndex = lines.findIndex((line) => line.trim().length > 0);
  const firstLine = lines[firstLineIndex] ?? "Thinking";
  const cleanLabel = firstLine
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .trim();
  const label =
    cleanLabel.length > 84 ? `${cleanLabel.slice(0, 84)}…` : cleanLabel;
  const detail = lines
    .filter((_, index) => index !== firstLineIndex)
    .join("\n")
    .trim();
  return {
    label: label || "Thought through the request",
    detail,
  };
}

function unwrapShellCommand(command: string) {
  const match = command.match(
    /^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-lc\s+(["'])([\s\S]*)\1$/,
  );
  return match?.[2] ?? command;
}

function shellCommandLabel(command: string) {
  const body = unwrapShellCommand(command).trim().replace(/\s+/g, " ");
  const tokens = body.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const executable = path.basename(tokens[0] ?? "command");
  if (["cat", "head", "tail", "sed"].includes(executable)) {
    const candidate = tokens.at(-1)?.replace(/^['"]|['"]$/g, "");
    if (candidate && !candidate.startsWith("-")) {
      return `Read ${path.basename(candidate)}`;
    }
  }
  if (
    executable === "grep" ||
    (executable === "rg" && !body.includes("--files"))
  ) {
    return "Searched the project";
  }
  if (executable === "find" || body.startsWith("rg --files")) {
    return "Listed files";
  }
  if (body.startsWith("git status")) {
    return "Checked git status";
  }
  if (body.startsWith("git diff")) {
    return "Reviewed changes";
  }
  return `Ran ${body}`;
}

function codexCommandLabel(item: JsonRecord) {
  const actions = Array.isArray(item.commandActions)
    ? item.commandActions
    : Array.isArray(item.command_actions)
      ? item.command_actions
      : [];
  const action = asRecord(actions[0]);
  const actionType = String(action?.type ?? "").toLowerCase();
  if (actionType === "read" && typeof action?.path === "string") {
    return `Read ${path.basename(action.path)}`;
  }
  if (actionType === "listfiles") {
    return "Listed files";
  }
  if (actionType === "search" && typeof action?.query === "string") {
    const query =
      action.query.length > 44 ? `${action.query.slice(0, 44)}…` : action.query;
    return `Searched for “${query}”`;
  }
  if (typeof item.command === "string") {
    return shellCommandLabel(item.command);
  }
  return "Ran command";
}

function codexFileChangeDetail(item: JsonRecord) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const detail = changes
    .map((value) => {
      const change = asRecord(value);
      if (!change || typeof change.path !== "string") {
        return "";
      }
      const kindRecord = asRecord(change.kind);
      const kind = String(kindRecord?.type ?? change.kind ?? "update");
      return [
        `${kind}  ${change.path}`,
        typeof change.diff === "string" ? change.diff : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n");
  return formatActivityValue(detail);
}

function codexFileChangeLabel(item: JsonRecord) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const firstChange = asRecord(changes[0]);
  if (changes.length !== 1 || typeof firstChange?.path !== "string") {
    return `Edited ${changes.length || "project"} files`;
  }

  const diff = typeof firstChange.diff === "string" ? firstChange.diff : "";
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  const stats =
    additions > 0 || deletions > 0 ? ` +${additions} -${deletions}` : "";
  return `Edited ${path.basename(firstChange.path)}${stats}`;
}

function codexActivityDescriptor(
  item: JsonRecord,
): CodexActivityDescriptor | null {
  const type = codexItemType(item);
  if (type === "reasoning") {
    const presentation = codexReasoningPresentation(item);
    return {
      kind: "reasoning",
      label: presentation.label,
      stepType: "reasoning",
      detail: presentation.detail,
    };
  }
  if (type === "plan") {
    return {
      kind: "reasoning",
      label: "Updated the plan",
      stepType: "plan",
      detail: typeof item.text === "string" ? item.text : undefined,
    };
  }
  if (type === "commandexecution") {
    return {
      kind: "command",
      label: codexCommandLabel(item),
      stepType: "command_execution",
      detail: typeof item.command === "string" ? item.command : undefined,
      output: formatActivityValue(
        item.aggregatedOutput ?? item.aggregated_output,
      ),
    };
  }
  if (type === "filechange") {
    return {
      kind: "file-change",
      label: codexFileChangeLabel(item),
      stepType: "file_change",
      detail: codexFileChangeDetail(item),
    };
  }
  if (type === "websearch") {
    const action = asRecord(item.action);
    const detail =
      typeof item.query === "string"
        ? item.query
        : typeof action?.query === "string"
          ? action.query
          : typeof action?.url === "string"
            ? action.url
            : undefined;
    return {
      kind: "web-search",
      label:
        action?.type === "openPage" ? "Opened a web page" : "Searched the web",
      stepType: "web_search",
      detail,
    };
  }
  if (type === "mcptoolcall" || type === "dynamictoolcall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    const server = typeof item.server === "string" ? item.server : undefined;
    const argumentsText = formatActivityValue(item.arguments);
    return {
      kind: "tool",
      label: humanizeToolName(tool),
      stepType: type === "mcptoolcall" ? "mcp_tool_call" : "dynamic_tool_call",
      detail: [server ? `Server: ${server}` : undefined, argumentsText]
        .filter(Boolean)
        .join("\n\n"),
      output: formatActivityValue(
        item.error ?? item.result ?? item.contentItems,
      ),
    };
  }
  if (type === "collabagenttoolcall" || type === "subagentactivity") {
    return {
      kind: "tool",
      label:
        type === "collabagenttoolcall"
          ? "Coordinated an agent"
          : "Agent activity",
      stepType: type,
      detail: formatActivityValue({
        tool: item.tool,
        agent: item.agentPath,
        prompt: item.prompt,
        model: item.model,
      }),
    };
  }
  if (type === "imageview") {
    return {
      kind: "tool",
      label: "Viewed an image",
      stepType: "image_view",
      detail: typeof item.path === "string" ? item.path : undefined,
    };
  }
  if (["agentmessage", "usermessage", "hookprompt", "error"].includes(type)) {
    return null;
  }
  return {
    kind: "other",
    label: humanizeToolName(String(item.type ?? "Working")),
    stepType: String(item.type ?? "working"),
    detail: formatActivityValue(item),
  };
}

function codexActivityState(item: JsonRecord, completed: boolean) {
  const status = String(item.status ?? "").toLowerCase();
  if (["failed", "declined", "error"].includes(status)) {
    return "ERROR";
  }
  return completed || status === "completed" ? "COMPLETED" : "RUNNING";
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

    if (item.type === "agent_message") {
      const partId = String(
        item.id ?? `codex-text-${state.nextTextPartSequence}`,
      );
      if (payload.type === "item.started") {
        state.nextTextPartSequence += 1;
        sendTextStart(event, request, partId);
      }
      if (
        payload.type === "item.completed" &&
        typeof item.text === "string" &&
        !state.response.endsWith(item.text)
      ) {
        sendTextStart(event, request, partId);
        sendDelta(event, request, state, item.text, partId);
      }
      return;
    }

    const activity = codexActivityDescriptor(item);
    if (activity) {
      sendActivity(event, request, state, {
        id: String(item.id ?? item.type ?? "working"),
        ...activity,
        status: codexActivityState(item, payload.type === "item.completed"),
      });
    }
    return;
  }

  if (payload.type === "turn.completed") {
    // `codex exec --json` reports cumulative processing for the entire turn
    // here, not the active model context. Treating it as context usage can
    // exceed the model window after a tool-heavy turn.
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

function codexAppServerAccess(request: AgentRunRequest) {
  const mode = resolveAgentAccessMode("codex", request.accessMode);
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    } as const;
  }
  return {
    approvalPolicy: "on-request",
    sandbox: mode === "auto" ? "workspace-write" : "read-only",
  } as const;
}

function startCodexRun(event: IpcMainInvokeEvent, request: AgentRunRequest) {
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
    activityLabels: new Map(),
    activityIdsByIndex: new Map(),
    textPartIdsByIndex: new Map(),
    nextTextPartSequence: 0,
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
        sendDelta(
          event,
          request,
          parserState,
          params.delta,
          typeof params.itemId === "string" ? params.itemId : undefined,
        );
      }
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      if (
        typeof params.itemId === "string" &&
        typeof params.delta === "string"
      ) {
        sendActivityDelta(event, request, parserState, {
          id: params.itemId,
          kind: "reasoning",
          label: "Thinking",
          field: "detail",
          text: params.delta,
        });
      }
      return;
    }

    if (
      method === "item/reasoning/summaryPartAdded" &&
      typeof params.itemId === "string" &&
      typeof params.summaryIndex === "number" &&
      params.summaryIndex > 0
    ) {
      sendActivityDelta(event, request, parserState, {
        id: params.itemId,
        kind: "reasoning",
        label: "Thinking",
        field: "detail",
        text: "\n\n",
      });
      return;
    }

    if (
      method === "item/commandExecution/outputDelta" &&
      typeof params.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      sendActivityDelta(event, request, parserState, {
        id: params.itemId,
        kind: "command",
        label: "Running command",
        field: "output",
        text: params.delta,
      });
      return;
    }

    if (
      method === "item/fileChange/outputDelta" &&
      typeof params.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      sendActivityDelta(event, request, parserState, {
        id: params.itemId,
        kind: "file-change",
        label: "Editing files",
        field: "output",
        text: params.delta,
      });
      return;
    }

    if (
      method === "item/mcpToolCall/progress" &&
      typeof params.itemId === "string" &&
      typeof params.message === "string"
    ) {
      sendActivityDelta(event, request, parserState, {
        id: params.itemId,
        kind: "tool",
        label: "Using tool",
        field: "output",
        text: `${params.message}\n`,
      });
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
      if (codexItemType(item) === "agentmessage") {
        const partId = String(
          item.id ?? `codex-text-${parserState.nextTextPartSequence}`,
        );
        if (method === "item/started") {
          parserState.nextTextPartSequence += 1;
          sendTextStart(event, request, partId);
        } else if (
          typeof item.text === "string" &&
          !parserState.response.endsWith(item.text)
        ) {
          sendTextStart(event, request, partId);
          sendDelta(event, request, parserState, item.text, partId);
        }
        return;
      }
      const activity = codexActivityDescriptor(item);
      if (activity) {
        sendActivity(event, request, parserState, {
          id: String(item.id ?? item.type ?? "working"),
          ...activity,
          status: codexActivityState(item, method === "item/completed"),
        });
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = asRecord(params.tokenUsage);
      const lastUsage = asRecord(
        tokenUsage?.last ?? tokenUsage?.lastTokenUsage,
      );
      const totalUsage = asRecord(
        tokenUsage?.total ?? tokenUsage?.totalTokenUsage,
      );
      const contextWindow = tokenCount(
        tokenUsage,
        "modelContextWindow",
        "model_context_window",
      );
      const processedTokens = tokenCount(
        totalUsage,
        "totalTokens",
        "total_tokens",
      );
      sendRecordUsage(
        event,
        request,
        parserState,
        lastUsage,
        contextWindow,
        processedTokens,
      );
      return;
    }

    if (method === "thread/compacted") {
      // The following token-usage notification carries the compacted context.
      // Keep the current value until that authoritative replacement arrives.
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
      serviceTier: request.speed === "fast" ? "priority" : "default",
      cwd,
      approvalsReviewer: "user",
      ...codexAppServerAccess(request),
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
      summary: "concise",
      effort: request.reasoningEffort ?? null,
      serviceTier: request.speed === "fast" ? "priority" : "default",
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
  const provider = request.provider ?? "gemini";
  if (provider === "claude") {
    parseClaudeLine(event, request, state, line);
  } else if (provider === "codex") {
    parseCodexLine(event, request, state, line);
  } else {
    parseGeminiLine(event, request, state, line);
  }
}

function createRunCommand(request: AgentRunRequest) {
  const provider = request.provider ?? "gemini";
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
    if (request.reasoningEffort) {
      args.push("--effort", request.reasoningEffort);
    }
    if (request.conversationId) {
      args.push("--resume", request.conversationId);
    }
    args.push(request.prompt);
    return { executable, args };
  }

  if (provider === "codex") {
    const args = request.conversationId
      ? [
          ...accessArgs,
          "-c",
          'model_reasoning_summary="concise"',
          "exec",
          "resume",
          "--json",
        ]
      : [
          ...accessArgs,
          "-c",
          'model_reasoning_summary="concise"',
          "exec",
          "--json",
        ];
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
  if (request.conversationId) {
    args.push("--resume", request.conversationId);
  }
  if (request.sourceFolder) {
    args.push("--skip-trust");
  }
  args.push("--prompt", request.prompt);
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

ipcMain.handle(
  "project:reveal-source-folder",
  async (_event, sourceFolder: string) => {
    if (typeof sourceFolder !== "string" || !path.isAbsolute(sourceFolder)) {
      throw new Error("Invalid project source folder.");
    }
    const resolvedPath = path.resolve(sourceFolder);
    if (!fs.statSync(resolvedPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("The project source folder no longer exists.");
    }
    const error = await shell.openPath(resolvedPath);
    if (error) {
      throw new Error(error);
    }
  },
);

ipcMain.handle("worktree:create", (_event, request: WorktreeCreateRequest) =>
  createSessionWorktree(request),
);

ipcMain.handle("worktree:reveal", (_event, worktreePath: string) => {
  if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) {
    throw new Error("Invalid worktree path.");
  }
  const resolvedPath = path.resolve(worktreePath);
  if (
    !pathIsInside(worktreeStorageRoot(), resolvedPath) ||
    !fs.statSync(resolvedPath, { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error("The managed worktree no longer exists.");
  }
  shell.showItemInFolder(resolvedPath);
});

ipcMain.handle(
  "response-link:open",
  async (_event, request: ResponseLinkOpenRequest) => {
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.href !== "string" ||
      request.href.length === 0 ||
      request.href.length > 16_384 ||
      (request.sourceFolder !== undefined &&
        (typeof request.sourceFolder !== "string" ||
          !path.isAbsolute(request.sourceFolder)))
    ) {
      throw new Error("Invalid response link.");
    }

    const target = classifyResponseLink(request.href);
    if (target.kind === "anchor") {
      return;
    }
    if (target.kind === "external") {
      await shell.openExternal(target.url);
      return;
    }

    const filePath = resolveResponseFilePath(
      target.href,
      request.sourceFolder,
      app.getPath("home"),
    );
    const error = await shell.openPath(filePath);
    if (error) {
      throw new Error(error);
    }
  },
);

ipcMain.handle("agent:models", () => listAvailableModels());

ipcMain.handle("agent:gemini-usage", () => {
  const executable = requireAgentExecutable("gemini");
  return getGeminiAccountUsage(executable, app.getPath("home"));
});

ipcMain.handle("agent:run", (event, request: AgentRunRequest) => {
  assertRunRequest(request);
  if (activeRuns.has(request.runId)) {
    throw new Error("This agent run is already active.");
  }

  if ((request.provider ?? "gemini") === "codex") {
    startCodexRun(event, request);
    return;
  }

  const { executable, args } = createRunCommand(request);
  const cwd = request.sourceFolder ?? app.getPath("home");

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
    activityLabels: new Map(),
    activityIdsByIndex: new Map(),
    textPartIdsByIndex: new Map(),
    nextTextPartSequence: 0,
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

ipcMain.handle("workspace:load", () => readWorkspaceFile());

ipcMain.handle("workspace:save", (_event, serialized: string) => {
  workspaceWriteQueue = workspaceWriteQueue
    .catch(() => undefined)
    .then(() => writeWorkspaceFile(serialized));
  return workspaceWriteQueue;
});

ipcMain.handle("devtools:open", (event) => {
  event.sender.openDevTools({ mode: "detach", activate: true });
});

function installDeveloperTools(mainWindow: BrowserWindow) {
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }
    const isInspectShortcut =
      input.key.toLowerCase() === "i" &&
      (process.platform === "darwin"
        ? input.meta && input.alt
        : input.control && input.shift);
    if (input.key === "F12" || isInspectShortcut) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
      );
    } else if (params.selectionText) {
      template.push({ role: "copy" }, { type: "separator" });
    }
    template.push({
      label: "Inspect Element",
      click: () => {
        const inspect = () =>
          mainWindow.webContents.inspectElement(params.x, params.y);
        if (mainWindow.webContents.isDevToolsOpened()) {
          inspect();
          return;
        }
        mainWindow.webContents.once("devtools-opened", inspect);
        mainWindow.webContents.openDevTools({ mode: "detach", activate: true });
      },
    });
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
}

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
      devTools: true,
    },
  });

  installDeveloperTools(mainWindow);

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

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

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
}
