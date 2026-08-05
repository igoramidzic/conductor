import { Archive, ChevronRight, Folder, Plus, Settings2 } from "lucide-react";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  onArchiveRecentChat: (sessionId: string) => void;
  onArchiveSession: (projectId: string, sessionId: string) => void;
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

function SessionTitle({
  title,
  placement,
}: {
  title: string;
  placement: "project" | "recent";
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState<SessionTitleMetrics>({
    overflows: false,
    shift: 0,
    duration: 4,
  });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) {
      return;
    }

    const measure = () => {
      const visibleWidth = viewport.clientWidth - text.offsetLeft;
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
  onArchive,
}: {
  session: ChatSession;
  active: boolean;
  placement: "project" | "recent";
  onSelect: () => void;
  onArchive: () => void;
}) {
  return (
    <SidebarMenuItem data-session-row="true">
      <SidebarMenuButton
        isActive={active}
        className="h-8 overflow-hidden px-1! text-[13px] font-normal text-sidebar-foreground/70"
        onClick={onSelect}
      >
        <SessionTitle title={session.title} placement={placement} />
      </SidebarMenuButton>
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
  onAction,
}: {
  label: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem data-sidebar-action-row="true">
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              data-sidebar-section-trigger="true"
              className="h-8 text-[13px] font-medium"
            />
          }
        >
          <span>{label}</span>
          <ChevronRight aria-hidden="true" />
        </CollapsibleTrigger>
        <SidebarMenuAction
          data-sidebar-add-action="true"
          className="text-sidebar-foreground/45 hover:text-sidebar-foreground"
          aria-label={actionLabel}
          onClick={(event) => {
            event.stopPropagation();
            onAction();
          }}
        >
          <Plus aria-hidden="true" />
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
  onArchiveRecentChat,
  onArchiveSession,
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
    return () => {
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
                  return (
                    <Collapsible
                      key={project.id}
                      open={project.expanded}
                      onOpenChange={() => onToggleProject(project.id)}
                      render={
                        <SidebarMenuItem data-sidebar-action-row="true" />
                      }
                    >
                      <CollapsibleTrigger
                        render={
                          <SidebarMenuButton
                            className={cn(
                              "h-8 pr-8 text-[13px]",
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
                        <span className="min-w-0 truncate">{project.name}</span>
                      </CollapsibleTrigger>
                      <SidebarMenuAction
                        data-sidebar-add-action="true"
                        className="text-sidebar-foreground/45 hover:text-sidebar-foreground"
                        aria-label={`New session in ${project.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCreateSession(project.id);
                        }}
                      >
                        <Plus aria-hidden="true" />
                      </SidebarMenuAction>

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
                  onRefresh={refreshUsage}
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
                        if (
                          value === "light" ||
                          value === "dark" ||
                          value === "system"
                        ) {
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
                      <DropdownMenuRadioItem value="system" closeOnClick>
                        System
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
