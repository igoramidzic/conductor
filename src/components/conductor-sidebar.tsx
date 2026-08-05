import {
  Archive,
  Folder,
  Monitor,
  Moon,
  Palette,
  Plus,
  Settings2,
  Sun,
} from "lucide-react";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

import { useTheme } from "@/components/theme-provider";
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
import { cn } from "@/lib/utils";
import type { ChatSession, Project } from "@/types";

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

function SessionTitle({ title }: { title: string }) {
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
      const shift = overflow > 1 ? overflow + 52 : 0;
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
      className="session-title relative min-w-0 flex-1 overflow-hidden pl-[26px]"
      data-overflow={metrics.overflows ? "true" : "false"}
      style={
        {
          "--session-title-shift": `${metrics.shift}px`,
          "--session-title-duration": `${metrics.duration}s`,
        } as CSSProperties
      }
    >
      <span
        ref={textRef}
        className="session-title-text inline-block whitespace-nowrap"
      >
        {title}
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
  onSelect,
  onArchive,
}: {
  session: ChatSession;
  active: boolean;
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
        <SessionTitle title={session.title} />
      </SidebarMenuButton>
      <SidebarMenuAction
        data-session-archive="true"
        className="right-1 z-20 size-5 opacity-0 transition-colors"
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
  expanded,
  actionLabel,
  onToggle,
  onAction,
}: {
  label: string;
  expanded: boolean;
  actionLabel: string;
  onToggle: () => void;
  onAction: () => void;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="h-8 text-[13px] font-medium text-sidebar-foreground/70"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span>{label}</span>
        </SidebarMenuButton>
        <SidebarMenuAction
          showOnHover
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
  const visibleRecentChats = recentChats.filter(
    (session) => !session.archived && session.messages.length > 0,
  );

  return (
    <Sidebar collapsible="offcanvas" className="border-sidebar-border">
      <SidebarHeader className="h-12 shrink-0 border-b border-sidebar-border p-0" />

      <SidebarContent className="pt-2">
        <SidebarGroup className="px-2 py-0">
          <SidebarSectionRow
            label="Projects"
            expanded={projectsExpanded}
            actionLabel="Add project"
            onToggle={onToggleProjects}
            onAction={onCreateProject}
          />

          {projectsExpanded ? (
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
                  (session) => !session.archived && session.messages.length > 0,
                );
                return (
                  <SidebarMenuItem key={project.id}>
                    <SidebarMenuButton
                      className={cn(
                        "h-8 pr-8 text-[13px]",
                        isActive && "bg-sidebar-accent font-medium",
                      )}
                      isActive={isActive}
                      onClick={() => onToggleProject(project.id)}
                    >
                      <Folder
                        className="size-3.5 text-sidebar-foreground/70"
                        aria-hidden="true"
                      />
                      <span>{project.name}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      aria-label={`New session in ${project.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCreateSession(project.id);
                      }}
                    >
                      <Plus aria-hidden="true" />
                    </SidebarMenuAction>

                    {project.expanded && visibleSessions.length > 0 ? (
                      <SidebarMenu className="mt-0.5 gap-0.5">
                        {visibleSessions.map((session) => {
                          const sessionIsActive =
                            session.id === activeSessionId;
                          return (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={sessionIsActive}
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
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          ) : null}
        </SidebarGroup>

        <SidebarGroup className="mt-2 px-2 py-0">
          <SidebarSectionRow
            label="Recent Chats"
            expanded={recentChatsExpanded}
            actionLabel="New chat"
            onToggle={onToggleRecentChats}
            onAction={onCreateRecentChat}
          />

          {recentChatsExpanded ? (
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
                  onSelect={() => onSelectRecentChat(session.id)}
                  onArchive={() => onArchiveRecentChat(session.id)}
                />
              ))}
            </SidebarMenu>
          ) : null}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
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
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Palette aria-hidden="true" />
                    <span>Theme</span>
                    <span className="ml-auto mr-1 text-xs capitalize text-muted-foreground">
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
                        <Sun aria-hidden="true" />
                        Light
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="dark" closeOnClick>
                        <Moon aria-hidden="true" />
                        Dark
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="system" closeOnClick>
                        <Monitor aria-hidden="true" />
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
