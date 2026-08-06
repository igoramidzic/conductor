import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { resolveAgentAccessMode } from "@/agent-access";
import { ChatWorkspace } from "@/components/chat-workspace";
import { ConductorSidebar } from "@/components/conductor-sidebar";
import {
  ProjectDialog,
  RemoveProjectDialog,
} from "@/components/project-dialog";
import { SessionRenameDialog } from "@/components/session-rename-dialog";
import { ThemeProvider } from "@/components/theme-provider";
import {
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  appendMessageText,
  ensureActivityPart,
  startTextPart,
} from "@/message-timeline";
import type {
  AgentAccessMode,
  AgentActivityKind,
  AgentApprovalDecision,
  AgentEvent,
  AgentModel,
  AgentModelSelection,
  AgentProvider,
  AgentReasoningEffort,
  AgentSpeed,
  AgentUsage,
  ChatMessage,
  ChatSession,
  Project,
  SessionExecutionMode,
  SessionWorktree,
  WorkspaceState,
} from "@/types";

const STORAGE_KEY = "conductor.workspace.v1";

type ArchivedSessionUndo = {
  projectId: string | null;
  sessionId: string;
  wasActive: boolean;
};

type RenamingSession = {
  projectId: string | null;
  sessionId: string;
};

const emptyWorkspace: WorkspaceState = {
  recentChatsExpanded: true,
  recentChats: [],
  projectsExpanded: true,
  projects: [],
  activeProjectId: null,
  activeSessionId: null,
};

const MAX_ACTIVITY_DETAIL_LENGTH = 12_000;

function inferLegacyActivityKind(label: string): AgentActivityKind {
  const normalized = label.toLowerCase();
  if (normalized.includes("think") || normalized.includes("reason")) {
    return "reasoning";
  }
  if (normalized.includes("command") || normalized.startsWith("ran ")) {
    return "command";
  }
  if (normalized.includes("edit") || normalized.includes("file")) {
    return "file-change";
  }
  if (normalized.includes("web") || normalized.includes("search")) {
    return "web-search";
  }
  return "other";
}

function appendActivityText(current: string | undefined, text: string) {
  const combined = `${current ?? ""}${text}`;
  if (combined.length <= MAX_ACTIVITY_DETAIL_LENGTH) {
    return combined;
  }
  return `…\n${combined.slice(-MAX_ACTIVITY_DETAIL_LENGTH)}`;
}

function normalizeUsage(value: unknown): AgentUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Partial<AgentUsage>;
  const tokenCount = (candidate: unknown) =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
      ? Math.floor(candidate)
      : undefined;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const usedTokens = tokenCount(usage.usedTokens);
  const contextWindow = tokenCount(usage.contextWindow);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    usedTokens === undefined ||
    (contextWindow !== undefined && usedTokens > contextWindow)
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    usedTokens,
    cachedInputTokens: tokenCount(usage.cachedInputTokens) ?? 0,
    contextWindow,
    processedTokens: tokenCount(usage.processedTokens),
  };
}

function normalizeWorktree(value: unknown): SessionWorktree | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const worktree = value as Partial<SessionWorktree>;
  if (
    typeof worktree.name !== "string" ||
    typeof worktree.path !== "string" ||
    typeof worktree.workingDirectory !== "string" ||
    typeof worktree.branch !== "string" ||
    typeof worktree.baseRef !== "string" ||
    typeof worktree.createdAt !== "number"
  ) {
    return undefined;
  }
  return worktree as SessionWorktree;
}

function migrateProvider(value: unknown): AgentProvider | undefined {
  if (value === "agy") {
    return "gemini";
  }
  return value === "gemini" || value === "claude" || value === "codex"
    ? value
    : undefined;
}

function normalizeReasoningEffort(
  value: unknown,
): AgentReasoningEffort | undefined {
  return typeof value === "string" &&
    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
      value,
    )
    ? (value as AgentReasoningEffort)
    : undefined;
}

function normalizeSpeed(value: unknown): AgentSpeed | undefined {
  return value === "standard" || value === "fast" ? value : undefined;
}

function markSessionViewed(
  workspace: WorkspaceState,
  projectId: string | null,
  sessionId: string | null,
): WorkspaceState {
  if (!sessionId) {
    return workspace;
  }

  if (projectId === null) {
    const session = workspace.recentChats.find((item) => item.id === sessionId);
    if (!session?.hasUnreadCompletion) {
      return workspace;
    }
    return {
      ...workspace,
      recentChats: workspace.recentChats.map((item) =>
        item.id === sessionId ? { ...item, hasUnreadCompletion: false } : item,
      ),
    };
  }

  const project = workspace.projects.find((item) => item.id === projectId);
  const session = project?.sessions.find((item) => item.id === sessionId);
  if (!session?.hasUnreadCompletion) {
    return workspace;
  }
  return {
    ...workspace,
    projects: workspace.projects.map((item) =>
      item.id === projectId
        ? {
            ...item,
            sessions: item.sessions.map((projectSession) =>
              projectSession.id === sessionId
                ? { ...projectSession, hasUnreadCompletion: false }
                : projectSession,
            ),
          }
        : item,
    ),
  };
}

function parseWorkspace(stored: string | null): WorkspaceState {
  try {
    if (!stored) {
      return emptyWorkspace;
    }

    const parsed = JSON.parse(stored) as WorkspaceState;
    if (!Array.isArray(parsed.projects)) {
      return emptyWorkspace;
    }

    const normalizeSession = (session: ChatSession): ChatSession => {
      const legacyProvider = session.provider as string | undefined;
      const legacyConversationProvider = session.conversationProvider as
        | string
        | undefined;
      const incompatibleConversation =
        legacyProvider === "agy" || legacyConversationProvider === "agy";
      const worktree = normalizeWorktree(session.worktree);
      return {
        ...session,
        archived: session.archived ?? false,
        hasUnreadCompletion: session.hasUnreadCompletion ?? false,
        executionMode:
          worktree || session.executionMode === "worktree"
            ? "worktree"
            : "local",
        worktree,
        provider: migrateProvider(legacyProvider),
        model: legacyProvider === "agy" ? "auto" : session.model,
        reasoningEffort: normalizeReasoningEffort(session.reasoningEffort),
        speed: normalizeSpeed(session.speed),
        conversationId: incompatibleConversation
          ? undefined
          : session.conversationId,
        conversationProvider: incompatibleConversation
          ? undefined
          : migrateProvider(legacyConversationProvider),
        usage: normalizeUsage(session.usage),
        messages: Array.isArray(session.messages)
          ? session.messages.map((message) => {
              const wasInterrupted =
                message.status === "thinking" || message.status === "streaming";
              return {
                ...message,
                chunks: Array.isArray(message.chunks)
                  ? message.chunks
                  : message.content
                    ? [message.content]
                    : [],
                activities: Array.isArray(message.activities)
                  ? message.activities
                      .filter(
                        (activity) =>
                          !(
                            (migrateProvider(legacyProvider) === "codex" ||
                              migrateProvider(legacyConversationProvider) ===
                                "codex") &&
                            activity.id === "item_0" &&
                            activity.label.toLowerCase() === "error"
                          ),
                      )
                      .map((activity) => ({
                        ...activity,
                        kind:
                          activity.kind ??
                          inferLegacyActivityKind(activity.label),
                      }))
                  : [],
                status: wasInterrupted ? "error" : message.status,
                runId: undefined,
                approval: undefined,
              } satisfies ChatMessage;
            })
          : [],
      };
    };

    const projects = parsed.projects.map((project) => ({
      ...project,
      expanded: project.expanded ?? true,
      sessions: Array.isArray(project.sessions)
        ? project.sessions.map(normalizeSession)
        : [],
    }));

    const activeProjectId = parsed.activeProjectId ?? null;
    const activeSessionId = parsed.activeSessionId ?? null;
    const normalizedWorkspace: WorkspaceState = {
      recentChatsExpanded: parsed.recentChatsExpanded ?? true,
      recentChats: Array.isArray(parsed.recentChats)
        ? parsed.recentChats.map(normalizeSession)
        : [],
      projectsExpanded: parsed.projectsExpanded ?? true,
      projects,
      activeProjectId,
      activeSessionId,
      accessModes: {
        gemini: resolveAgentAccessMode(
          "gemini",
          (parsed.accessModes as Record<string, AgentAccessMode> | undefined)
            ?.gemini ??
            (parsed.accessModes as Record<string, AgentAccessMode> | undefined)
              ?.agy,
        ),
        claude: resolveAgentAccessMode("claude", parsed.accessModes?.claude),
        codex: resolveAgentAccessMode("codex", parsed.accessModes?.codex),
      },
      lastModel:
        parsed.lastModel &&
        migrateProvider(parsed.lastModel.provider) &&
        typeof parsed.lastModel.model === "string" &&
        parsed.lastModel.model.length > 0
          ? {
              provider: migrateProvider(
                parsed.lastModel.provider,
              ) as AgentProvider,
              model:
                (parsed.lastModel.provider as string) === "agy"
                  ? "auto"
                  : parsed.lastModel.model,
              reasoningEffort: normalizeReasoningEffort(
                parsed.lastModel.reasoningEffort,
              ),
              speed: normalizeSpeed(parsed.lastModel.speed),
            }
          : undefined,
    };
    return markSessionViewed(
      normalizedWorkspace,
      activeProjectId,
      activeSessionId,
    );
  } catch {
    return emptyWorkspace;
  }
}

function loadLocalWorkspace() {
  return parseWorkspace(window.localStorage.getItem(STORAGE_KEY));
}

function workspaceHasContent(workspace: WorkspaceState) {
  return workspace.projects.length > 0 || workspace.recentChats.length > 0;
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

function titleFromPrompt(prompt: string) {
  const title =
    prompt.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "New session";
  return title || "New session";
}

function worktreeNameFromPrompt(prompt: string) {
  const normalized = titleFromPrompt(prompt)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return normalized || "new-session";
}

function updateRun(
  workspace: WorkspaceState,
  event: AgentEvent,
): WorkspaceState {
  let didChange = false;

  function updateSession(session: ChatSession, isActive: boolean): ChatSession {
    const messageIndex = session.messages.findIndex(
      (message) => message.runId === event.runId,
    );
    if (messageIndex === -1) {
      return session;
    }

    if (event.type === "conversation") {
      didChange = true;
      return {
        ...session,
        conversationId: event.conversationId,
        conversationProvider: event.provider,
      };
    }

    if (event.type === "started") {
      return session;
    }

    if (event.type === "usage") {
      didChange = true;
      return { ...session, usage: normalizeUsage(event.usage) };
    }

    const messages = [...session.messages];
    const message = messages[messageIndex];
    if (!message) {
      return session;
    }

    if (event.type === "approval") {
      messages[messageIndex] = {
        ...message,
        approval: event.approval,
      };
      didChange = true;
      return { ...session, messages };
    }

    if (event.type === "text-start") {
      messages[messageIndex] = startTextPart(message, event.partId);
      didChange = messages[messageIndex] !== message;
      return didChange ? { ...session, messages } : session;
    }

    if (event.type === "approval-resolved") {
      if (message.approval?.id !== event.approvalId) {
        return session;
      }
      messages[messageIndex] = {
        ...message,
        approval: undefined,
      };
      didChange = true;
      return { ...session, messages };
    }

    if (event.type === "activity-delta") {
      const currentActivities = message.activities ?? [];
      const activityIndex = currentActivities.findIndex(
        (activity) => activity.id === event.activityId,
      );
      const activities = [...currentActivities];
      const currentActivity = activities[activityIndex];
      const activity = {
        id: event.activityId,
        kind: currentActivity?.kind ?? event.kind,
        label: currentActivity?.label ?? event.label ?? "Working",
        status: currentActivity?.status ?? ("running" as const),
        detail: currentActivity?.detail,
        output: currentActivity?.output,
        [event.field]: appendActivityText(
          currentActivity?.[event.field],
          event.text,
        ),
      };
      if (activityIndex === -1) {
        activities.push(activity);
      } else {
        activities[activityIndex] = activity;
      }
      messages[messageIndex] = {
        ...message,
        activities,
        parts: ensureActivityPart(message, event.activityId),
      };
      didChange = true;
      return { ...session, messages };
    }

    if (event.type === "status") {
      const stepType = event.stepType.toLowerCase();
      if (
        ["user_input", "agent_response", "checkpoint", "unknown"].includes(
          stepType,
        )
      ) {
        return session;
      }

      const normalizedState = event.state.toUpperCase();
      const activityStatus = ["ERROR", "FAILED", "DECLINED"].includes(
        normalizedState,
      )
        ? "error"
        : ["CANCELLED", "CANCELED", "INTERRUPTED"].includes(normalizedState)
          ? "cancelled"
          : ["DONE", "COMPLETE", "COMPLETED", "SUCCESS"].includes(
                normalizedState,
              )
            ? "complete"
            : "running";
      const currentActivities = message.activities ?? [];
      const activityIndex = currentActivities.findIndex(
        (activity) => activity.id === event.activityId,
      );
      const activities = [...currentActivities];
      const currentActivity = activities[activityIndex];
      const activity = {
        id: event.activityId,
        label: event.label,
        status: activityStatus,
        kind:
          event.kind ??
          currentActivity?.kind ??
          inferLegacyActivityKind(event.label),
        detail: event.detail ?? currentActivity?.detail,
        output: event.output ?? currentActivity?.output,
      } as const;
      if (activityIndex === -1) {
        activities.push(activity);
      } else {
        activities[activityIndex] = activity;
      }
      messages[messageIndex] = {
        ...message,
        activities,
        parts: ensureActivityPart(message, event.activityId),
      };
      didChange = true;
      return { ...session, messages };
    }

    didChange = true;
    if (event.type === "delta") {
      messages[messageIndex] = {
        ...appendMessageText(message, event.text, event.partId),
        status: "streaming",
      };
    } else if (event.type === "complete") {
      const response =
        event.response.length > message.content.length
          ? event.response
          : message.content;
      messages[messageIndex] = {
        ...message,
        content: response,
        chunks:
          response === message.content ? message.chunks : [event.response],
        activities: (message.activities ?? []).map((activity) => ({
          ...activity,
          status:
            activity.status === "running"
              ? ("complete" as const)
              : activity.status,
        })),
        status: "complete",
        completedAt: Date.now(),
        runId: undefined,
        approval: undefined,
      };
    } else if (event.type === "cancelled") {
      messages[messageIndex] = {
        ...message,
        activities: (message.activities ?? []).map((activity) => ({
          ...activity,
          status:
            activity.status === "running"
              ? ("cancelled" as const)
              : activity.status,
        })),
        status: "cancelled",
        completedAt: Date.now(),
        runId: undefined,
        approval: undefined,
      };
    } else if (event.type === "error") {
      const messageWithError = appendMessageText(
        message,
        event.message,
        `${message.id}-error`,
      );
      messages[messageIndex] = {
        ...messageWithError,
        activities: (message.activities ?? []).map((activity) => ({
          ...activity,
          status:
            activity.status === "running"
              ? ("error" as const)
              : activity.status,
        })),
        status: "error",
        completedAt: Date.now(),
        runId: undefined,
        approval: undefined,
      };
    }

    return {
      ...session,
      messages,
      hasUnreadCompletion:
        event.type === "complete" ? !isActive : session.hasUnreadCompletion,
    };
  }

  const recentChats = workspace.recentChats.map((session) =>
    updateSession(
      session,
      workspace.activeProjectId === null &&
        workspace.activeSessionId === session.id,
    ),
  );
  const projects = workspace.projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) =>
      updateSession(
        session,
        workspace.activeProjectId === project.id &&
          workspace.activeSessionId === session.id,
      ),
    ),
  }));

  return didChange ? { ...workspace, recentChats, projects } : workspace;
}

function FloatingSidebarTrigger() {
  const isMac = window.electron.platform === "darwin";
  const { state } = useSidebar();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarTrigger
            className={cn(
              "app-no-drag fixed top-2.5 z-50 pointer-events-auto",
              isMac ? "left-[84px]" : "left-3",
              state === "expanded"
                ? "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                : "text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          />
        }
      />
      <TooltipContent side="bottom" sideOffset={8}>
        Toggle sidebar
      </TooltipContent>
    </Tooltip>
  );
}

function ConductorApp() {
  const [workspace, setWorkspace] =
    useState<WorkspaceState>(loadLocalWorkspace);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const hasPersistentWorkspaceRef = useRef(false);
  const [workspacePersistenceReady, setWorkspacePersistenceReady] =
    useState(false);
  const [availableModels, setAvailableModels] = useState<AgentModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(
    null,
  );
  const [renamingSession, setRenamingSession] =
    useState<RenamingSession | null>(null);
  const archiveUndoStackRef = useRef<ArchivedSessionUndo[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [pendingSession, setPendingSession] = useState<{
    projectId: string | null;
    session: ChatSession;
  } | null>(null);
  const pendingSessionRef = useRef(pendingSession);
  const [preparingSessionId, setPreparingSessionId] = useState<string | null>(
    null,
  );
  const [sessionPreparationError, setSessionPreparationError] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const loadPersistentWorkspace = window.electron.loadWorkspace;
    const savePersistentWorkspace = window.electron.saveWorkspace;

    if (
      typeof loadPersistentWorkspace !== "function" ||
      typeof savePersistentWorkspace !== "function"
    ) {
      return;
    }

    void loadPersistentWorkspace()
      .then(async (stored) => {
        if (!active) {
          return;
        }
        if (stored) {
          hasPersistentWorkspaceRef.current = true;
          setWorkspace(parseWorkspace(stored));
          return;
        }

        const localWorkspace = workspaceRef.current;
        if (workspaceHasContent(localWorkspace)) {
          await savePersistentWorkspace(JSON.stringify(localWorkspace));
          if (active) {
            hasPersistentWorkspaceRef.current = true;
          }
        }
      })
      .catch((error) => {
        console.error("Unable to load the saved workspace.", error);
      })
      .finally(() => {
        if (active) {
          setWorkspacePersistenceReady(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const serialized = JSON.stringify(workspace);
    window.localStorage.setItem(STORAGE_KEY, serialized);

    if (!workspacePersistenceReady) {
      return;
    }
    if (!hasPersistentWorkspaceRef.current && !workspaceHasContent(workspace)) {
      return;
    }

    hasPersistentWorkspaceRef.current = true;
    void window.electron.saveWorkspace(serialized).catch((error) => {
      console.error("Unable to save the workspace.", error);
    });
  }, [workspace, workspacePersistenceReady]);

  useEffect(() => {
    return window.electron.onAgentEvent((event) => {
      console.info("[agent] Renderer received event.", {
        runId: event.runId,
        type: event.type,
        characters:
          event.type === "delta"
            ? event.text.length
            : event.type === "complete"
              ? event.response.length
              : event.type === "error"
                ? event.message.length
                : undefined,
      });
      setWorkspace((current) => updateRun(current, event));
    });
  }, []);

  useEffect(() => {
    let active = true;
    void window.electron
      .listAgentModels()
      .then((models) => {
        if (active) {
          setAvailableModels(models);
        }
      })
      .catch(() => {
        if (active) {
          setAvailableModels([]);
        }
      })
      .finally(() => {
        if (active) {
          setModelsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const activeProject = useMemo(
    () =>
      workspace.projects.find(
        (project) => project.id === workspace.activeProjectId,
      ) ?? null,
    [workspace.activeProjectId, workspace.projects],
  );
  const activeSession = useMemo(() => {
    if (pendingSession?.projectId === workspace.activeProjectId) {
      return pendingSession.session;
    }
    const sessions = activeProject?.sessions ?? workspace.recentChats;
    return (
      sessions.find(
        (session) =>
          session.id === workspace.activeSessionId && !session.archived,
      ) ?? null
    );
  }, [
    activeProject,
    pendingSession,
    workspace.activeProjectId,
    workspace.activeSessionId,
    workspace.recentChats,
  ]);
  const editingProject =
    workspace.projects.find((project) => project.id === editingProjectId) ??
    null;
  const removingProject =
    workspace.projects.find((project) => project.id === removingProjectId) ??
    null;
  const sessionBeingRenamed = renamingSession
    ? renamingSession.projectId === null
      ? (workspace.recentChats.find(
          (session) => session.id === renamingSession.sessionId,
        ) ?? null)
      : (workspace.projects
          .find((project) => project.id === renamingSession.projectId)
          ?.sessions.find(
            (session) => session.id === renamingSession.sessionId,
          ) ?? null)
    : null;

  function defaultModelForNewSession(): AgentModelSelection | undefined {
    if (activeSession?.model) {
      return resolveModelSelection({
        provider: activeSession.provider ?? "gemini",
        model: activeSession.model,
        reasoningEffort: activeSession.reasoningEffort,
        speed: activeSession.speed,
      });
    }

    const selection =
      workspace.lastModel ??
      availableModels.find((model) => model.provider === "gemini") ??
      availableModels[0];
    return selection ? resolveModelSelection(selection) : undefined;
  }

  function resolveModelSelection(
    selection: AgentModelSelection,
  ): AgentModelSelection {
    const metadata = availableModels.find(
      (model) =>
        model.provider === selection.provider &&
        model.model === selection.model,
    );
    if (!metadata) {
      return {
        ...selection,
        speed: selection.speed ?? "standard",
      };
    }
    const reasoningEfforts = metadata?.reasoningEfforts ?? [];
    const reasoningEffort = reasoningEfforts.includes(
      selection.reasoningEffort as AgentReasoningEffort,
    )
      ? selection.reasoningEffort
      : metadata?.defaultReasoningEffort;
    const speeds = metadata?.speeds ?? ["standard"];
    const speed = speeds.includes(selection.speed as AgentSpeed)
      ? selection.speed
      : (metadata.defaultSpeed ?? speeds[0]);

    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort,
      speed,
    };
  }

  function clearPendingSession(sessionId?: string) {
    if (sessionId && pendingSessionRef.current?.session.id !== sessionId) {
      return;
    }
    pendingSessionRef.current = null;
    setPendingSession(null);
  }

  function createProject(name: string, sourceFolder: string) {
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      sourceFolder,
      expanded: true,
      sessions: [],
    };
    const currentPending = pendingSessionRef.current;
    if (currentPending) {
      const nextPending = { ...currentPending, projectId: project.id };
      pendingSessionRef.current = nextPending;
      setPendingSession(nextPending);
    }
    setWorkspace((current) => ({
      ...current,
      projectsExpanded: true,
      projects: [...current.projects, project],
      activeProjectId: project.id,
      activeSessionId: null,
    }));
  }

  function openCreateProject() {
    setEditingProjectId(null);
    setProjectDialogOpen(true);
  }

  function openEditProject(projectId: string) {
    setEditingProjectId(projectId);
    setProjectDialogOpen(true);
  }

  function saveProject(name: string, sourceFolder: string) {
    if (!editingProjectId) {
      createProject(name, sourceFolder);
      return;
    }

    setWorkspace((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === editingProjectId
          ? { ...project, name, sourceFolder }
          : project,
      ),
    }));
  }

  function createSession(projectId: string | null) {
    const currentPending = pendingSessionRef.current;
    if (currentPending) {
      if (currentPending.projectId !== projectId) {
        const nextPending = {
          ...currentPending,
          projectId,
          session:
            projectId === null
              ? { ...currentPending.session, executionMode: "local" as const }
              : currentPending.session,
        };
        pendingSessionRef.current = nextPending;
        setPendingSession(nextPending);
      }
      setWorkspace((current) => ({
        ...current,
        recentChatsExpanded:
          projectId === null ? true : current.recentChatsExpanded,
        activeProjectId: projectId,
        activeSessionId: null,
        projects: current.projects.map((project) =>
          project.id === projectId ? { ...project, expanded: true } : project,
        ),
      }));
      return;
    }
    const defaultModel = defaultModelForNewSession();
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: "New session",
      createdAt: Date.now(),
      archived: false,
      hasUnreadCompletion: false,
      executionMode: "local",
      provider: defaultModel?.provider,
      model: defaultModel?.model,
      reasoningEffort: defaultModel?.reasoningEffort,
      speed: defaultModel?.speed,
      messages: [],
    };
    const pending = { projectId, session };
    pendingSessionRef.current = pending;
    setPendingSession(pending);
    setWorkspace((current) => ({
      ...current,
      recentChatsExpanded:
        projectId === null ? true : current.recentChatsExpanded,
      activeProjectId: projectId,
      activeSessionId: null,
      projects: current.projects.map((project) =>
        project.id === projectId ? { ...project, expanded: true } : project,
      ),
    }));
  }

  function selectProject(projectId: string | null) {
    const currentPending = pendingSessionRef.current;
    if (currentPending && currentPending.projectId !== projectId) {
      const nextPending = {
        ...currentPending,
        projectId,
        session:
          projectId === null
            ? { ...currentPending.session, executionMode: "local" as const }
            : currentPending.session,
      };
      pendingSessionRef.current = nextPending;
      setPendingSession(nextPending);
    }
    setWorkspace((current) => ({
      ...current,
      activeProjectId: projectId,
      activeSessionId:
        current.activeProjectId === projectId ? current.activeSessionId : null,
    }));
  }

  function toggleProject(projectId: string) {
    setWorkspace((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? { ...project, expanded: !project.expanded }
          : project,
      ),
    }));
  }

  function selectSession(projectId: string, sessionId: string) {
    clearPendingSession();
    setWorkspace((current) =>
      markSessionViewed(
        {
          ...current,
          activeProjectId: projectId,
          activeSessionId: sessionId,
        },
        projectId,
        sessionId,
      ),
    );
  }

  function selectRecentChat(sessionId: string) {
    clearPendingSession();
    setWorkspace((current) =>
      markSessionViewed(
        {
          ...current,
          activeProjectId: null,
          activeSessionId: sessionId,
        },
        null,
        sessionId,
      ),
    );
  }

  function renameSession(name: string) {
    if (!renamingSession) {
      return;
    }

    setWorkspace((current) =>
      renamingSession.projectId === null
        ? {
            ...current,
            recentChats: current.recentChats.map((session) =>
              session.id === renamingSession.sessionId
                ? { ...session, title: name }
                : session,
            ),
          }
        : {
            ...current,
            projects: current.projects.map((project) =>
              project.id === renamingSession.projectId
                ? {
                    ...project,
                    sessions: project.sessions.map((session) =>
                      session.id === renamingSession.sessionId
                        ? { ...session, title: name }
                        : session,
                    ),
                  }
                : project,
            ),
          },
    );
  }

  function archiveSession(projectId: string, sessionId: string) {
    const snapshot = workspaceRef.current;
    const session = snapshot.projects
      .find((project) => project.id === projectId)
      ?.sessions.find((item) => item.id === sessionId);
    if (!session || session.archived) {
      return;
    }
    archiveUndoStackRef.current.push({
      projectId,
      sessionId,
      wasActive:
        snapshot.activeProjectId === projectId &&
        snapshot.activeSessionId === sessionId,
    });

    setWorkspace((current) => {
      const project = current.projects.find((item) => item.id === projectId);
      if (!project) {
        return current;
      }

      const fallbackSessionId = [...project.sessions]
        .reverse()
        .find(
          (session) =>
            session.id !== sessionId &&
            !session.archived &&
            session.messages.length > 0,
        )?.id;

      return {
        ...current,
        activeSessionId:
          current.activeProjectId === projectId &&
          current.activeSessionId === sessionId
            ? (fallbackSessionId ?? null)
            : current.activeSessionId,
        projects: current.projects.map((item) =>
          item.id === projectId
            ? {
                ...item,
                sessions: item.sessions.map((session) =>
                  session.id === sessionId
                    ? { ...session, archived: true }
                    : session,
                ),
              }
            : item,
        ),
      };
    });
  }

  function archiveRecentChat(sessionId: string) {
    const snapshot = workspaceRef.current;
    const session = snapshot.recentChats.find((item) => item.id === sessionId);
    if (!session || session.archived) {
      return;
    }
    archiveUndoStackRef.current.push({
      projectId: null,
      sessionId,
      wasActive:
        snapshot.activeProjectId === null &&
        snapshot.activeSessionId === sessionId,
    });

    setWorkspace((current) => {
      const fallbackSessionId = [...current.recentChats]
        .reverse()
        .find(
          (session) =>
            session.id !== sessionId &&
            !session.archived &&
            session.messages.length > 0,
        )?.id;

      return {
        ...current,
        activeSessionId:
          current.activeProjectId === null &&
          current.activeSessionId === sessionId
            ? (fallbackSessionId ?? null)
            : current.activeSessionId,
        recentChats: current.recentChats.map((session) =>
          session.id === sessionId ? { ...session, archived: true } : session,
        ),
      };
    });
  }

  function archiveProjectChats(projectId: string) {
    const snapshot = workspaceRef.current;
    const project = snapshot.projects.find((item) => item.id === projectId);
    const sessionsToArchive =
      project?.sessions.filter(
        (session) => !session.archived && session.messages.length > 0,
      ) ?? [];
    if (sessionsToArchive.length === 0) {
      return;
    }

    const sessionIds = new Set(sessionsToArchive.map((session) => session.id));
    archiveUndoStackRef.current.push(
      ...sessionsToArchive.map((session) => ({
        projectId,
        sessionId: session.id,
        wasActive:
          snapshot.activeProjectId === projectId &&
          snapshot.activeSessionId === session.id,
      })),
    );

    setWorkspace((current) => ({
      ...current,
      activeSessionId:
        current.activeProjectId === projectId &&
        current.activeSessionId &&
        sessionIds.has(current.activeSessionId)
          ? null
          : current.activeSessionId,
      projects: current.projects.map((item) =>
        item.id === projectId
          ? {
              ...item,
              sessions: item.sessions.map((session) =>
                sessionIds.has(session.id)
                  ? { ...session, archived: true }
                  : session,
              ),
            }
          : item,
      ),
    }));
  }

  function undoArchivedSession() {
    while (archiveUndoStackRef.current.length > 0) {
      const undo = archiveUndoStackRef.current.pop();
      if (!undo) {
        return;
      }

      const snapshot = workspaceRef.current;
      const archivedSession =
        undo.projectId === null
          ? snapshot.recentChats.find(
              (session) => session.id === undo.sessionId && session.archived,
            )
          : snapshot.projects
              .find((project) => project.id === undo.projectId)
              ?.sessions.find(
                (session) => session.id === undo.sessionId && session.archived,
              );
      if (!archivedSession) {
        continue;
      }

      setWorkspace((current) => {
        if (undo.projectId === null) {
          return {
            ...current,
            recentChatsExpanded: true,
            activeProjectId: undo.wasActive ? null : current.activeProjectId,
            activeSessionId: undo.wasActive
              ? undo.sessionId
              : current.activeSessionId,
            recentChats: current.recentChats.map((session) =>
              session.id === undo.sessionId
                ? { ...session, archived: false }
                : session,
            ),
          };
        }

        return {
          ...current,
          projectsExpanded: true,
          activeProjectId: undo.wasActive
            ? undo.projectId
            : current.activeProjectId,
          activeSessionId: undo.wasActive
            ? undo.sessionId
            : current.activeSessionId,
          projects: current.projects.map((project) =>
            project.id === undo.projectId
              ? {
                  ...project,
                  expanded: true,
                  sessions: project.sessions.map((session) =>
                    session.id === undo.sessionId
                      ? { ...session, archived: false }
                      : session,
                  ),
                }
              : project,
          ),
        };
      });
      return;
    }
  }

  function markProjectChatsRead(projectId: string) {
    setWorkspace((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.hasUnreadCompletion
                  ? { ...session, hasUnreadCompletion: false }
                  : session,
              ),
            }
          : project,
      ),
    }));
  }

  function revealProject(projectId: string) {
    const project = workspaceRef.current.projects.find(
      (item) => item.id === projectId,
    );
    if (!project) {
      return;
    }

    void window.electron
      .revealProjectFolder(project.sourceFolder)
      .catch((error) => {
        console.error("Unable to reveal the project folder.", error);
      });
  }

  function removeProject(projectId: string) {
    if (pendingSessionRef.current?.projectId === projectId) {
      clearPendingSession();
    }
    archiveUndoStackRef.current = archiveUndoStackRef.current.filter(
      (entry) => entry.projectId !== projectId,
    );
    setWorkspace((current) => ({
      ...current,
      activeProjectId:
        current.activeProjectId === projectId ? null : current.activeProjectId,
      activeSessionId:
        current.activeProjectId === projectId ? null : current.activeSessionId,
      projects: current.projects.filter((project) => project.id !== projectId),
    }));
    setEditingProjectId((current) => (current === projectId ? null : current));
    setRemovingProjectId(null);
  }

  function selectModel(selection: AgentModelSelection) {
    if (!activeSession) {
      return;
    }
    const resolvedSelection = resolveModelSelection(selection);

    if (pendingSession?.session.id === activeSession.id) {
      const nextPending = {
        ...pendingSession,
        session: {
          ...pendingSession.session,
          provider: resolvedSelection.provider,
          model: resolvedSelection.model,
          reasoningEffort: resolvedSelection.reasoningEffort,
          speed: resolvedSelection.speed,
          usage:
            pendingSession.session.provider === resolvedSelection.provider &&
            pendingSession.session.model === resolvedSelection.model
              ? pendingSession.session.usage
              : undefined,
        },
      };
      pendingSessionRef.current = nextPending;
      setPendingSession(nextPending);
      setWorkspace((current) => ({
        ...current,
        lastModel: {
          ...resolvedSelection,
        },
      }));
      return;
    }

    const projectId = activeProject?.id ?? null;
    const sessionId = activeSession.id;
    setWorkspace((current) => ({
      ...current,
      lastModel: {
        ...resolvedSelection,
      },
      recentChats:
        projectId === null
          ? current.recentChats.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    provider: resolvedSelection.provider,
                    model: resolvedSelection.model,
                    reasoningEffort: resolvedSelection.reasoningEffort,
                    speed: resolvedSelection.speed,
                    usage:
                      session.provider === resolvedSelection.provider &&
                      session.model === resolvedSelection.model
                        ? session.usage
                        : undefined,
                  }
                : session,
            )
          : current.recentChats,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === sessionId
                  ? {
                      ...session,
                      provider: resolvedSelection.provider,
                      model: resolvedSelection.model,
                      reasoningEffort: resolvedSelection.reasoningEffort,
                      speed: resolvedSelection.speed,
                      usage:
                        session.provider === resolvedSelection.provider &&
                        session.model === resolvedSelection.model
                          ? session.usage
                          : undefined,
                    }
                  : session,
              ),
            }
          : project,
      ),
    }));
  }

  function selectAccessMode(accessMode: AgentAccessMode) {
    const provider = activeSession?.provider ?? "gemini";
    setWorkspace((current) => ({
      ...current,
      accessModes: {
        ...current.accessModes,
        [provider]: resolveAgentAccessMode(provider, accessMode),
      },
    }));
  }

  function selectExecutionMode(executionMode: SessionExecutionMode) {
    if (
      !activeProject ||
      !activeSession ||
      activeSession.executionMode === executionMode ||
      activeSession.messages.length > 0 ||
      activeSession.worktree
    ) {
      return;
    }

    setSessionPreparationError(null);
    if (pendingSession?.session.id === activeSession.id) {
      const nextPending = {
        ...pendingSession,
        session: {
          ...pendingSession.session,
          executionMode,
        },
      };
      pendingSessionRef.current = nextPending;
      setPendingSession(nextPending);
      return;
    }

    const projectId = activeProject.id;
    const sessionId = activeSession.id;
    setWorkspace((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === sessionId
                  ? { ...session, executionMode }
                  : session,
              ),
            }
          : project,
      ),
    }));
  }

  async function sendPrompt(prompt: string) {
    if (!activeSession) {
      return false;
    }

    const projectId = activeProject?.id ?? null;
    const sessionId = activeSession.id;
    let runSession = activeSession;
    setSessionPreparationError(null);

    if (
      activeProject &&
      activeSession.executionMode === "worktree" &&
      !activeSession.worktree
    ) {
      setPreparingSessionId(sessionId);
      try {
        const worktree = await window.electron.createWorktree({
          sessionId,
          sourceFolder: activeProject.sourceFolder,
          name: worktreeNameFromPrompt(prompt),
        });
        runSession = { ...activeSession, worktree };
      } catch (error) {
        setSessionPreparationError({
          sessionId,
          message:
            error instanceof Error
              ? error.message
              : "Could not create the worktree.",
        });
        return false;
      } finally {
        setPreparingSessionId((current) =>
          current === sessionId ? null : current,
        );
      }
    }

    const runId = crypto.randomUUID();
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      chunks: [prompt],
      createdAt: now,
      status: "complete",
      activities: [],
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      chunks: [],
      createdAt: now + 1,
      status: "thinking",
      activities: [],
      parts: [],
      runId,
    };

    const rawSelectedModel = runSession.model
      ? {
          provider: runSession.provider ?? "gemini",
          model: runSession.model,
          reasoningEffort: runSession.reasoningEffort,
          speed: runSession.speed,
        }
      : (workspace.lastModel ??
        availableModels.find(
          (model) =>
            model.provider ===
            (runSession.provider ??
              runSession.conversationProvider ??
              "gemini"),
        ) ??
        availableModels.find((model) => model.provider === "gemini") ??
        availableModels[0]);
    const selectedModel = rawSelectedModel
      ? resolveModelSelection(rawSelectedModel)
      : undefined;
    const provider = selectedModel?.provider ?? runSession.provider ?? "gemini";
    const accessMode = resolveAgentAccessMode(
      provider,
      workspace.accessModes?.[provider],
    );
    const conversationId =
      (runSession.conversationProvider ?? "gemini") === provider
        ? runSession.conversationId
        : undefined;
    const isPendingSession = pendingSession?.session.id === sessionId;
    setWorkspace((current) => ({
      ...current,
      activeSessionId: sessionId,
      lastModel: selectedModel ? { ...selectedModel } : current.lastModel,
      recentChats:
        projectId === null
          ? isPendingSession
            ? [
                ...current.recentChats,
                {
                  ...runSession,
                  provider,
                  model: selectedModel?.model,
                  reasoningEffort: selectedModel?.reasoningEffort,
                  speed: selectedModel?.speed,
                  title: titleFromPrompt(prompt),
                  hasUnreadCompletion: false,
                  messages: [userMessage, assistantMessage],
                },
              ]
            : current.recentChats.map((session) =>
                session.id === sessionId
                  ? {
                      ...session,
                      executionMode: runSession.executionMode,
                      worktree: runSession.worktree,
                      provider,
                      model: selectedModel?.model,
                      reasoningEffort: selectedModel?.reasoningEffort,
                      speed: selectedModel?.speed,
                      hasUnreadCompletion: false,
                      title:
                        session.messages.length === 0
                          ? titleFromPrompt(prompt)
                          : session.title,
                      messages: [
                        ...session.messages,
                        userMessage,
                        assistantMessage,
                      ],
                    }
                  : session,
              )
          : current.recentChats,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: isPendingSession
                ? [
                    ...project.sessions,
                    {
                      ...runSession,
                      provider,
                      model: selectedModel?.model,
                      reasoningEffort: selectedModel?.reasoningEffort,
                      speed: selectedModel?.speed,
                      title: titleFromPrompt(prompt),
                      hasUnreadCompletion: false,
                      messages: [userMessage, assistantMessage],
                    },
                  ]
                : project.sessions.map((session) =>
                    session.id === sessionId
                      ? {
                          ...session,
                          executionMode: runSession.executionMode,
                          worktree: runSession.worktree,
                          provider,
                          model: selectedModel?.model,
                          reasoningEffort: selectedModel?.reasoningEffort,
                          speed: selectedModel?.speed,
                          hasUnreadCompletion: false,
                          title:
                            session.messages.length === 0
                              ? titleFromPrompt(prompt)
                              : session.title,
                          messages: [
                            ...session.messages,
                            userMessage,
                            assistantMessage,
                          ],
                        }
                      : session,
                  ),
            }
          : project,
      ),
    }));
    if (isPendingSession) {
      clearPendingSession(sessionId);
    }

    void window.electron
      .runAgent({
        runId,
        prompt,
        sourceFolder:
          runSession.worktree?.workingDirectory ?? activeProject?.sourceFolder,
        provider,
        model: selectedModel?.model,
        reasoningEffort: selectedModel?.reasoningEffort,
        speed: selectedModel?.speed,
        accessMode,
        conversationId,
      })
      .catch((error: unknown) => {
        console.error(`[agent:${runId}] Renderer failed to start run.`, error);
        setWorkspace((current) =>
          updateRun(current, {
            runId,
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not start the agent.",
          }),
        );
      });
    return true;
  }

  function cancelRun(runId: string) {
    void window.electron.cancelAgent(runId);
  }

  function respondToApproval(
    runId: string,
    approvalId: string,
    decision: AgentApprovalDecision,
  ) {
    void window.electron
      .respondToAgentApproval({ runId, approvalId, decision })
      .catch((error: unknown) => {
        setWorkspace((current) =>
          updateRun(current, {
            runId,
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not send the approval response.",
          }),
        );
      });
  }

  const createSessionRef = useRef(createSession);
  createSessionRef.current = createSession;
  const undoArchivedSessionRef = useRef(undoArchivedSession);
  undoArchivedSessionRef.current = undoArchivedSession;

  useEffect(() => {
    function handleArchiveUndoShortcut(event: globalThis.KeyboardEvent) {
      if (
        event.metaKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z" &&
        !isEditableKeyboardTarget(event.target) &&
        archiveUndoStackRef.current.length > 0
      ) {
        event.preventDefault();
        undoArchivedSessionRef.current();
      }
    }

    window.addEventListener("keydown", handleArchiveUndoShortcut);
    return () =>
      window.removeEventListener("keydown", handleArchiveUndoShortcut);
  }, []);

  useEffect(() => {
    function handleNewSessionShortcut(event: globalThis.KeyboardEvent) {
      if (
        event.metaKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        if (pendingSessionRef.current) {
          return;
        }

        const currentWorkspace = workspaceRef.current;
        const projectId = currentWorkspace.projects.some(
          (project) => project.id === currentWorkspace.activeProjectId,
        )
          ? currentWorkspace.activeProjectId
          : null;
        createSessionRef.current(projectId);
      }
    }

    window.addEventListener("keydown", handleNewSessionShortcut);
    return () =>
      window.removeEventListener("keydown", handleNewSessionShortcut);
  }, []);

  useEffect(() => {
    function handleTerminalShortcut(event: globalThis.KeyboardEvent) {
      const usesPlatformModifier =
        window.electron.platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (
        usesPlatformModifier &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "j"
      ) {
        event.preventDefault();
        setTerminalOpen((current) => !current);
      }
    }

    window.addEventListener("keydown", handleTerminalShortcut);
    return () => window.removeEventListener("keydown", handleTerminalShortcut);
  }, []);

  return (
    <>
      <ConductorSidebar
        recentChats={workspace.recentChats}
        recentChatsExpanded={workspace.recentChatsExpanded}
        projects={workspace.projects}
        projectsExpanded={workspace.projectsExpanded}
        pendingProjectId={pendingSession ? pendingSession.projectId : undefined}
        activeSessionId={workspace.activeSessionId}
        onToggleRecentChats={() =>
          setWorkspace((current) => ({
            ...current,
            recentChatsExpanded: !current.recentChatsExpanded,
          }))
        }
        onToggleProjects={() =>
          setWorkspace((current) => ({
            ...current,
            projectsExpanded: !current.projectsExpanded,
          }))
        }
        onToggleProject={toggleProject}
        onSelectRecentChat={selectRecentChat}
        onSelectSession={selectSession}
        onRenameRecentChat={(sessionId) =>
          setRenamingSession({ projectId: null, sessionId })
        }
        onRenameSession={(projectId, sessionId) =>
          setRenamingSession({ projectId, sessionId })
        }
        onArchiveRecentChat={archiveRecentChat}
        onArchiveSession={archiveSession}
        onArchiveProjectChats={archiveProjectChats}
        onMarkProjectChatsRead={markProjectChatsRead}
        onRevealProject={revealProject}
        onEditProject={openEditProject}
        onRemoveProject={setRemovingProjectId}
        onCreateProject={openCreateProject}
        onCreateRecentChat={() => createSession(null)}
        onCreateSession={createSession}
      />
      <ChatWorkspace
        projects={workspace.projects}
        project={activeProject}
        session={activeSession}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        accessMode={resolveAgentAccessMode(
          activeSession?.provider ?? "gemini",
          workspace.accessModes?.[activeSession?.provider ?? "gemini"],
        )}
        onCreateProject={openCreateProject}
        onCreateSession={createSession}
        onProjectChange={selectProject}
        onModelChange={selectModel}
        onAccessModeChange={selectAccessMode}
        onExecutionModeChange={selectExecutionMode}
        onSend={sendPrompt}
        onCancel={cancelRun}
        onApproval={respondToApproval}
        terminalOpen={terminalOpen}
        onTerminalOpenChange={setTerminalOpen}
        preparingSession={preparingSessionId === activeSession?.id}
        preparationError={
          sessionPreparationError?.sessionId === activeSession?.id
            ? sessionPreparationError?.message
            : undefined
        }
      />
      <FloatingSidebarTrigger />
      <ProjectDialog
        open={projectDialogOpen}
        project={editingProject}
        onOpenChange={(open) => {
          setProjectDialogOpen(open);
          if (!open) {
            setEditingProjectId(null);
          }
        }}
        onSave={saveProject}
      />
      <RemoveProjectDialog
        open={removingProject !== null}
        project={removingProject}
        onOpenChange={(open) => {
          if (!open) {
            setRemovingProjectId(null);
          }
        }}
        onConfirm={() => {
          if (removingProjectId) {
            removeProject(removingProjectId);
          }
        }}
      />
      <SessionRenameDialog
        open={renamingSession !== null}
        session={sessionBeingRenamed}
        onOpenChange={(open) => {
          if (!open) {
            setRenamingSession(null);
          }
        }}
        onSave={renameSession}
      />
    </>
  );
}

export function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="conductor.theme.v1">
      <TooltipProvider delay={300}>
        <SidebarProvider
          className="h-svh min-h-0 overflow-hidden"
          style={{ "--sidebar-width": "16rem" } as CSSProperties}
        >
          <ConductorApp />
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
