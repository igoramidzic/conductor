import {
  Archive,
  Check,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  GitFork,
  LoaderCircle,
  Pencil,
  Plus,
  Settings2,
  SquarePen,
  Trash2,
} from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useTheme } from "@/components/theme-provider";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { UsageMenuItem } from "@/components/usage-menu-item";
import { cn } from "@/lib/utils";
import type { ChatSession, GeminiAccountUsage, Project } from "@/types";

type ConductorSidebarProps = {
  recentChats: ChatSession[];
  recentChatsExpanded: boolean;
  projects: Project[];
  projectsExpanded: boolean;
  pendingProjectId?: string | null;
  activeSessionId: string | null;
  onToggleRecentChats: () => void;
  onToggleProjects: () => void;
  onToggleProject: (projectId: string) => void;
  onSelectRecentChat: (sessionId: string) => void;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onRenameRecentChat: (sessionId: string) => void;
  onRenameSession: (projectId: string, sessionId: string) => void;
  onArchiveRecentChat: (sessionId: string) => void;
  onArchiveSession: (projectId: string, sessionId: string) => void;
  onArchiveProjectChats: (projectId: string) => void;
  onMarkProjectChatsRead: (projectId: string) => void;
  onRevealProject: (projectId: string) => void;
  onEditProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onCreateProject: () => void;
  onCreateRecentChat: () => void;
  onCreateSession: (projectId: string) => void;
};

type SessionTitleMetrics = {
  overflows: boolean;
  shift: number;
  duration: number;
};

const SESSION_TITLE_LOOP_GAP = 52;
const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

type SessionIndicatorState =
  | "working"
  | "needs-interaction"
  | "unread-completion";

function getSessionIndicatorState(
  session: ChatSession,
): SessionIndicatorState | null {
  const activeMessage = session.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      (message.status === "thinking" || message.status === "streaming"),
  );
  if (activeMessage?.approval) {
    return "needs-interaction";
  }
  if (activeMessage) {
    return "working";
  }
  return session.hasUnreadCompletion ? "unread-completion" : null;
}

function SessionIndicator({ state }: { state: SessionIndicatorState }) {
  const label =
    state === "working"
      ? "Session is working"
      : state === "needs-interaction"
        ? "Session needs interaction"
        : "Session has a new completed response";

  return (
    <span
      data-session-indicator="true"
      className="pointer-events-none absolute top-1/2 right-1 z-10 flex size-5 -translate-y-1/2 items-center justify-center"
      role="status"
      aria-label={label}
    >
      {state === "working" ? (
        <LoaderCircle
          className="size-3.5 animate-spin text-sidebar-foreground/55 motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <span
          className={cn(
            "size-2 rounded-full",
            state === "needs-interaction" ? "bg-amber-400" : "bg-primary",
          )}
          aria-hidden="true"
        />
      )}
    </span>
  );
}

function SessionTitle({
  title,
  placement,
}: {
  title: string;
  placement: "project" | "recent";
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const rightFadeRef = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState<SessionTitleMetrics>({
    overflows: false,
    shift: 0,
    duration: 4,
  });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    const rightFade = rightFadeRef.current;
    if (!viewport || !text || !rightFade) {
      return;
    }

    const measure = () => {
      const visibleWidth = Math.max(
        0,
        viewport.clientWidth - text.offsetLeft - rightFade.offsetWidth,
      );
      const overflow = Math.max(0, text.scrollWidth - visibleWidth);
      const shift =
        overflow > 1 ? text.scrollWidth + SESSION_TITLE_LOOP_GAP : 0;
      const nextMetrics = {
        overflows: overflow > 1,
        shift,
        duration: Math.max(4.2, shift / 32 + 2.4),
      };
      setMetrics((current) => {
        if (
          current.overflows === nextMetrics.overflows &&
          current.shift === nextMetrics.shift &&
          current.duration === nextMetrics.duration
        ) {
          return current;
        }
        return nextMetrics;
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    observer.observe(rightFade);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={viewportRef}
      className={cn(
        "session-title relative min-w-0 flex-1 overflow-hidden",
        placement === "project" ? "pl-7" : "pl-1",
      )}
      data-overflow={metrics.overflows ? "true" : "false"}
      style={
        {
          "--session-title-shift": `${metrics.shift}px`,
          "--session-title-duration": `${metrics.duration}s`,
        } as CSSProperties
      }
    >
      <span className="session-title-track">
        <span ref={textRef} className="session-title-text">
          {title}
        </span>
        {metrics.overflows ? (
          <span className="session-title-text" aria-hidden="true">
            {title}
          </span>
        ) : null}
      </span>
      <span
        className="session-title-fade session-title-fade-left"
        aria-hidden="true"
      />
      <span
        ref={rightFadeRef}
        className="session-title-fade session-title-fade-right"
        aria-hidden="true"
      />
    </div>
  );
}

function SessionRow({
  session,
  active,
  placement,
  onSelect,
  onRename,
  onArchive,
}: {
  session: ChatSession;
  active: boolean;
  placement: "project" | "recent";
  onSelect: () => void;
  onRename: () => void;
  onArchive: () => void;
}) {
  const indicatorState = getSessionIndicatorState(session);

  return (
    <SidebarMenuItem
      data-session-row="true"
      data-session-status={indicatorState ?? undefined}
    >
      <SidebarMenuButton
        isActive={active}
        className="h-8 overflow-hidden px-1! text-[13px] font-normal text-sidebar-foreground/70"
        onClick={onSelect}
        onDoubleClick={onRename}
      >
        <SessionTitle title={session.title} placement={placement} />
      </SidebarMenuButton>
      {indicatorState ? <SessionIndicator state={indicatorState} /> : null}
      {session.worktree && !indicatorState ? (
        <span
          data-session-worktree="true"
          className="pointer-events-none absolute top-1.5 right-1 z-10 flex size-5 items-center justify-center text-primary/75 transition-opacity"
          role="img"
          aria-label={`Worktree: ${session.worktree.name}`}
        >
          <GitFork className="size-3.5" aria-hidden="true" />
        </span>
      ) : null}
      <SidebarMenuAction
        data-session-archive="true"
        className="right-1 z-20 size-5 opacity-0"
        aria-label={`Archive ${session.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onArchive();
        }}
      >
        <Archive aria-hidden="true" />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

function SidebarSectionRow({
  label,
  actionLabel,
  actionIcon = "plus",
  active = false,
  onAction,
}: {
  label: string;
  actionLabel: string;
  actionIcon?: "plus" | "compose";
  active?: boolean;
  onAction: () => void;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem
        className="group/sidebar-action-row"
        data-sidebar-action-row="true"
      >
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              data-sidebar-action-trigger="true"
              data-sidebar-section-trigger="true"
              className="h-8 text-[13px] font-medium"
              isActive={active}
            />
          }
        >
          <span>{label}</span>
          <ChevronRight aria-hidden="true" />
        </CollapsibleTrigger>
        <SidebarMenuAction
          data-sidebar-add-action="true"
          data-sidebar-row-action="true"
          className="text-sidebar-foreground/45 hover:text-sidebar-foreground"
          aria-label={actionLabel}
          onClick={(event) => {
            event.stopPropagation();
            onAction();
          }}
        >
          {actionIcon === "compose" ? (
            <SquarePen aria-hidden="true" />
          ) : (
            <Plus aria-hidden="true" />
          )}
        </SidebarMenuAction>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function ConductorSidebar({
  recentChats,
  recentChatsExpanded,
  projects,
  projectsExpanded,
  pendingProjectId,
  activeSessionId,
  onToggleRecentChats,
  onToggleProjects,
  onToggleProject,
  onSelectRecentChat,
  onSelectSession,
  onRenameRecentChat,
  onRenameSession,
  onArchiveRecentChat,
  onArchiveSession,
  onArchiveProjectChats,
  onMarkProjectChatsRead,
  onRevealProject,
  onEditProject,
  onRemoveProject,
  onCreateProject,
  onCreateRecentChat,
  onCreateSession,
}: ConductorSidebarProps) {
  const { theme, setTheme } = useTheme();
  const [usage, setUsage] = useState<GeminiAccountUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState<string | null>(null);
  const usageRequestIdRef = useRef(0);
  const visibleRecentChats = recentChats.filter(
    (session) => !session.archived && session.messages.length > 0,
  );

  const refreshUsage = useCallback(async () => {
    const requestId = usageRequestIdRef.current + 1;
    usageRequestIdRef.current = requestId;
    setUsageLoading(true);
    setUsageError(null);

    try {
      const nextUsage = await window.electron.getGeminiUsage();
      if (requestId === usageRequestIdRef.current) {
        setUsage(nextUsage);
      }
    } catch (refreshError) {
      if (requestId === usageRequestIdRef.current) {
        setUsageError(
          refreshError instanceof Error
            ? refreshError.message
            : "Usage could not be loaded.",
        );
      }
    } finally {
      if (requestId === usageRequestIdRef.current) {
        setUsageLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
    const refreshInterval = window.setInterval(() => {
      void refreshUsage();
    }, USAGE_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(refreshInterval);
      usageRequestIdRef.current += 1;
    };
  }, [refreshUsage]);

  return (
    <Sidebar collapsible="offcanvas" className="border-sidebar-border">
      <SidebarHeader className="h-12 shrink-0 border-b border-sidebar-border p-0" />

      <SidebarContent className="pt-2">
        <SidebarGroup className="px-2 py-0">
          <Collapsible open={projectsExpanded} onOpenChange={onToggleProjects}>
            <SidebarSectionRow
              label="Projects"
              actionLabel="Add project"
              onAction={onCreateProject}
            />

            <CollapsibleContent className="sidebar-collapse">
              <SidebarMenu className="mt-0.5 gap-0.5">
                {projects.length === 0 ? (
                  <SidebarMenuItem>
                    <div className="flex h-8 items-center px-2 text-xs text-sidebar-foreground/45">
                      No projects yet.
                    </div>
                  </SidebarMenuItem>
                ) : null}

                {projects.map((project) => {
                  const isActive = project.id === pendingProjectId;
                  const visibleSessions = project.sessions.filter(
                    (session) =>
                      !session.archived && session.messages.length > 0,
                  );
                  const hasUnreadChats = project.sessions.some(
                    (session) => session.hasUnreadCompletion,
                  );
                  return (
                    <Collapsible
                      key={project.id}
                      open={project.expanded}
                      onOpenChange={() => onToggleProject(project.id)}
                      render={<SidebarMenuItem />}
                    >
                      <div
                        className="group/sidebar-action-row relative"
                        data-sidebar-action-row="true"
                      >
                        <CollapsibleTrigger
                          render={
                            <SidebarMenuButton
                              data-sidebar-action-trigger="true"
                              className={cn(
                                "h-8 pr-14 text-[13px]",
                                isActive && "bg-sidebar-accent font-medium",
                              )}
                              isActive={isActive}
                            />
                          }
                        >
                          <Folder
                            className="size-3.5 text-sidebar-foreground/70"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 truncate">
                            {project.name}
                          </span>
                        </CollapsibleTrigger>
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger
                            render={
                              <SidebarMenuAction
                                data-sidebar-project-action="true"
                                data-sidebar-row-action="true"
                                className="right-7 text-sidebar-foreground/45 hover:text-sidebar-foreground"
                                aria-label={`More options for ${project.name}`}
                              />
                            }
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Ellipsis aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            side="right"
                            align="start"
                            sideOffset={8}
                            className="w-52"
                          >
                            <DropdownMenuItem
                              className="h-8 px-2 text-xs"
                              onClick={() => onEditProject(project.id)}
                            >
                              <Pencil aria-hidden="true" />
                              Edit project
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="h-8 px-2 text-xs"
                              disabled={visibleSessions.length === 0}
                              onClick={() => onArchiveProjectChats(project.id)}
                            >
                              <Archive aria-hidden="true" />
                              Archive chats
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="h-8 px-2 text-xs"
                              disabled={!hasUnreadChats}
                              onClick={() => onMarkProjectChatsRead(project.id)}
                            >
                              <Check aria-hidden="true" />
                              Mark all as read
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="h-8 px-2 text-xs"
                              onClick={() => onRevealProject(project.id)}
                            >
                              <FolderOpen aria-hidden="true" />
                              Reveal in Finder
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              className="h-8 px-2 text-xs"
                              onClick={() => onRemoveProject(project.id)}
                            >
                              <Trash2 aria-hidden="true" />
                              Remove project
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <SidebarMenuAction
                          data-sidebar-add-action="true"
                          data-sidebar-row-action="true"
                          className="text-sidebar-foreground/45 hover:text-sidebar-foreground"
                          aria-label={`New session in ${project.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onCreateSession(project.id);
                          }}
                        >
                          <SquarePen aria-hidden="true" />
                        </SidebarMenuAction>
                      </div>

                      <CollapsibleContent className="sidebar-collapse">
                        <SidebarMenu className="mt-0.5 gap-0.5">
                          {visibleSessions.length === 0 ? (
                            <SidebarMenuItem>
                              <div className="flex h-8 items-center pl-[30px] text-xs text-sidebar-foreground/45">
                                No chats
                              </div>
                            </SidebarMenuItem>
                          ) : null}
                          {visibleSessions.map((session) => {
                            const sessionIsActive =
                              session.id === activeSessionId;
                            return (
                              <SessionRow
                                key={session.id}
                                session={session}
                                active={sessionIsActive}
                                placement="project"
                                onSelect={() =>
                                  onSelectSession(project.id, session.id)
                                }
                                onRename={() =>
                                  onRenameSession(project.id, session.id)
                                }
                                onArchive={() =>
                                  onArchiveSession(project.id, session.id)
                                }
                              />
                            );
                          })}
                        </SidebarMenu>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })}
              </SidebarMenu>
            </CollapsibleContent>
          </Collapsible>
        </SidebarGroup>

        <SidebarGroup className="mt-2 px-2 py-0">
          <Collapsible
            open={recentChatsExpanded}
            onOpenChange={onToggleRecentChats}
          >
            <SidebarSectionRow
              label="Recents"
              actionLabel="New chat"
              actionIcon="compose"
              active={pendingProjectId === null}
              onAction={onCreateRecentChat}
            />

            <CollapsibleContent className="sidebar-collapse">
              <SidebarMenu className="mt-0.5 gap-0.5">
                {visibleRecentChats.length === 0 ? (
                  <SidebarMenuItem>
                    <div className="flex h-8 items-center px-2 text-xs text-sidebar-foreground/45">
                      No recent chats.
                    </div>
                  </SidebarMenuItem>
                ) : null}
                {visibleRecentChats.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    placement="recent"
                    onSelect={() => onSelectRecentChat(session.id)}
                    onRename={() => onRenameRecentChat(session.id)}
                    onArchive={() => onArchiveRecentChat(session.id)}
                  />
                ))}
              </SidebarMenu>
            </CollapsibleContent>
          </Collapsible>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="h-9 text-[13px] text-sidebar-foreground/75" />
                }
              >
                <Settings2 aria-hidden="true" />
                <span>Settings</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-56"
              >
                <UsageMenuItem
                  usage={usage}
                  loading={usageLoading}
                  error={usageError}
                />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <span>Theme</span>
                    <span className="min-w-0 flex-1 text-right text-xs capitalize text-muted-foreground">
                      {theme}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-36">
                    <DropdownMenuRadioGroup
                      value={theme}
                      onValueChange={(value) => {
                        if (value === "light" || value === "dark") {
                          setTheme(value);
                        }
                      }}
                    >
                      <DropdownMenuRadioItem value="light" closeOnClick>
                        Light
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark" closeOnClick>
                        Dark
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
