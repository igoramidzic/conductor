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
import { ProjectDialog } from "@/components/project-dialog";
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
import type {
  AgentAccessMode,
  AgentApprovalDecision,
  AgentEvent,
  AgentModel,
  AgentModelSelection,
  AgentProvider,
  ChatMessage,
  ChatSession,
  Project,
  WorkspaceState,
} from "@/types";

const STORAGE_KEY = "conductor.workspace.v1";

const emptyWorkspace: WorkspaceState = {
  recentChatsExpanded: true,
  recentChats: [],
  projectsExpanded: true,
  projects: [],
  activeProjectId: null,
  activeSessionId: null,
};

function migrateProvider(value: unknown): AgentProvider | undefined {
  if (value === "agy") {
    return "gemini";
  }
  return value === "gemini" || value === "claude" || value === "codex"
    ? value
    : undefined;
}

function loadWorkspace(): WorkspaceState {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
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
      return {
        ...session,
        archived: session.archived ?? false,
        provider: migrateProvider(legacyProvider),
        model: legacyProvider === "agy" ? "auto" : session.model,
        conversationId: incompatibleConversation
          ? undefined
          : session.conversationId,
        conversationProvider: incompatibleConversation
          ? undefined
          : migrateProvider(legacyConversationProvider),
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

    return {
      recentChatsExpanded: parsed.recentChatsExpanded ?? true,
      recentChats: Array.isArray(parsed.recentChats)
        ? parsed.recentChats.map(normalizeSession)
        : [],
      projectsExpanded: parsed.projectsExpanded ?? true,
      projects,
      activeProjectId: parsed.activeProjectId ?? null,
      activeSessionId: parsed.activeSessionId ?? null,
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
            }
          : undefined,
    };
  } catch {
    return emptyWorkspace;
  }
}

function titleFromPrompt(prompt: string) {
  const title =
    prompt.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "New session";
  return title || "New session";
}

function updateRun(
  workspace: WorkspaceState,
  event: AgentEvent,
): WorkspaceState {
  let didChange = false;

  function updateSession(session: ChatSession): ChatSession {
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

    if (event.type === "status") {
      const stepType = event.stepType.toLowerCase();
      if (
        ["user_input", "agent_response", "checkpoint", "unknown"].includes(
          stepType,
        )
      ) {
        return session;
      }

      const activityStatus = [
        "DONE",
        "COMPLETE",
        "COMPLETED",
        "SUCCESS",
      ].includes(event.state.toUpperCase())
        ? "complete"
        : "running";
      const currentActivities = message.activities ?? [];
      const activityIndex = currentActivities.findIndex(
        (activity) => activity.id === event.activityId,
      );
      const activities = [...currentActivities];
      const activity = {
        id: event.activityId,
        label: event.label,
        status: activityStatus,
      } as const;
      if (activityIndex === -1) {
        activities.push(activity);
      } else {
        activities[activityIndex] = activity;
      }
      messages[messageIndex] = { ...message, activities };
      didChange = true;
      return { ...session, messages };
    }

    didChange = true;
    if (event.type === "delta") {
      messages[messageIndex] = {
        ...message,
        content: `${message.content}${event.text}`,
        chunks: [...message.chunks, event.text],
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
          status: "complete",
        })),
        status: "complete",
        runId: undefined,
        approval: undefined,
      };
    } else if (event.type === "cancelled") {
      messages[messageIndex] = {
        ...message,
        status: "cancelled",
        runId: undefined,
        approval: undefined,
      };
    } else if (event.type === "error") {
      messages[messageIndex] = {
        ...message,
        content: message.content
          ? `${message.content}\n\n${event.message}`
          : event.message,
        chunks: [...message.chunks, event.message],
        status: "error",
        runId: undefined,
        approval: undefined,
      };
    }

    return { ...session, messages };
  }

  const recentChats = workspace.recentChats.map(updateSession);
  const projects = workspace.projects.map((project) => ({
    ...project,
    sessions: project.sessions.map(updateSession),
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
  const [workspace, setWorkspace] = useState<WorkspaceState>(loadWorkspace);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [availableModels, setAvailableModels] = useState<AgentModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [pendingSession, setPendingSession] = useState<{
    projectId: string | null;
    session: ChatSession;
  } | null>(null);
  const pendingSessionRef = useRef(pendingSession);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  }, [workspace]);

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

  function defaultModelForNewSession(): AgentModelSelection | undefined {
    if (activeSession?.model) {
      return {
        provider: activeSession.provider ?? "gemini",
        model: activeSession.model,
      };
    }

    return (
      workspace.lastModel ??
      availableModels.find((model) => model.provider === "gemini") ??
      availableModels[0]
    );
  }

  function clearPendingSession() {
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

  function createSession(projectId: string | null) {
    if (pendingSessionRef.current) {
      return;
    }
    const defaultModel = defaultModelForNewSession();
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: "New session",
      createdAt: Date.now(),
      archived: false,
      provider: defaultModel?.provider,
      model: defaultModel?.model,
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
      const nextPending = { ...currentPending, projectId };
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
    setWorkspace((current) => ({
      ...current,
      activeProjectId: projectId,
      activeSessionId: sessionId,
    }));
  }

  function selectRecentChat(sessionId: string) {
    clearPendingSession();
    setWorkspace((current) => ({
      ...current,
      activeProjectId: null,
      activeSessionId: sessionId,
    }));
  }

  function archiveSession(projectId: string, sessionId: string) {
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

  function selectModel(selection: AgentModel) {
    if (!activeSession) {
      return;
    }

    if (pendingSession?.session.id === activeSession.id) {
      const nextPending = {
        ...pendingSession,
        session: {
          ...pendingSession.session,
          provider: selection.provider,
          model: selection.model,
        },
      };
      pendingSessionRef.current = nextPending;
      setPendingSession(nextPending);
      setWorkspace((current) => ({
        ...current,
        lastModel: {
          provider: selection.provider,
          model: selection.model,
        },
      }));
      return;
    }

    const projectId = activeProject?.id ?? null;
    const sessionId = activeSession.id;
    setWorkspace((current) => ({
      ...current,
      lastModel: {
        provider: selection.provider,
        model: selection.model,
      },
      recentChats:
        projectId === null
          ? current.recentChats.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    provider: selection.provider,
                    model: selection.model,
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
                      provider: selection.provider,
                      model: selection.model,
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

  function sendPrompt(prompt: string) {
    if (!activeSession) {
      return;
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
      runId,
    };

    const projectId = activeProject?.id ?? null;
    const sessionId = activeSession.id;
    const selectedModel = activeSession.model
      ? {
          provider: activeSession.provider ?? "gemini",
          model: activeSession.model,
        }
      : (workspace.lastModel ??
        availableModels.find(
          (model) =>
            model.provider ===
            (activeSession.provider ??
              activeSession.conversationProvider ??
              "gemini"),
        ) ??
        availableModels.find((model) => model.provider === "gemini") ??
        availableModels[0]);
    const provider =
      selectedModel?.provider ?? activeSession.provider ?? "gemini";
    const accessMode = resolveAgentAccessMode(
      provider,
      workspace.accessModes?.[provider],
    );
    const conversationId =
      (activeSession.conversationProvider ?? "gemini") === provider
        ? activeSession.conversationId
        : undefined;
    const isPendingSession = pendingSession?.session.id === sessionId;
    setWorkspace((current) => ({
      ...current,
      activeSessionId: sessionId,
      lastModel: selectedModel
        ? {
            provider: selectedModel.provider,
            model: selectedModel.model,
          }
        : current.lastModel,
      recentChats:
        projectId === null
          ? isPendingSession
            ? [
                ...current.recentChats,
                {
                  ...activeSession,
                  provider,
                  model: selectedModel?.model,
                  title: titleFromPrompt(prompt),
                  messages: [userMessage, assistantMessage],
                },
              ]
            : current.recentChats.map((session) =>
                session.id === sessionId
                  ? {
                      ...session,
                      provider,
                      model: selectedModel?.model,
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
                      ...activeSession,
                      provider,
                      model: selectedModel?.model,
                      title: titleFromPrompt(prompt),
                      messages: [userMessage, assistantMessage],
                    },
                  ]
                : project.sessions.map((session) =>
                    session.id === sessionId
                      ? {
                          ...session,
                          provider,
                          model: selectedModel?.model,
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
      clearPendingSession();
    }

    void window.electron
      .runAgent({
        runId,
        prompt,
        sourceFolder: activeProject?.sourceFolder,
        provider,
        model: selectedModel?.model,
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
        onArchiveRecentChat={archiveRecentChat}
        onArchiveSession={archiveSession}
        onCreateProject={() => setProjectDialogOpen(true)}
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
        onCreateProject={() => setProjectDialogOpen(true)}
        onCreateSession={createSession}
        onProjectChange={selectProject}
        onModelChange={selectModel}
        onAccessModeChange={selectAccessMode}
        onSend={sendPrompt}
        onCancel={cancelRun}
        onApproval={respondToApproval}
        terminalOpen={terminalOpen}
        onTerminalOpenChange={setTerminalOpen}
      />
      <FloatingSidebarTrigger />
      <ProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        onCreate={createProject}
      />
    </>
  );
}

export function App() {
  return (
    <ThemeProvider defaultTheme="system" storageKey="conductor.theme.v1">
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
