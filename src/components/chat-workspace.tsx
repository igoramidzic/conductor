import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Brain,
  ChartPie,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FilePenLine,
  Folder,
  FolderOpen,
  GitFork,
  Globe2,
  ListChecks,
  LoaderCircle,
  Monitor,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Square,
  SquareTerminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getAgentAccessModes,
  getAgentProviderLabel,
  resolveAgentAccessMode,
} from "@/agent-access";
import { TerminalPanel } from "@/components/terminal-panel";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  AgentAccessMode,
  AgentActivity,
  AgentApprovalDecision,
  AgentApprovalRequest,
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
} from "@/types";

type ChatWorkspaceProps = {
  projects: Project[];
  project: Project | null;
  session: ChatSession | null;
  availableModels: AgentModel[];
  modelsLoading: boolean;
  accessMode: AgentAccessMode;
  onCreateProject: () => void;
  onCreateSession: (projectId: string | null) => void;
  onProjectChange: (projectId: string | null) => void;
  onModelChange: (selection: AgentModelSelection) => void;
  onAccessModeChange: (mode: AgentAccessMode) => void;
  onExecutionModeChange: (mode: SessionExecutionMode) => void;
  onSend: (prompt: string) => Promise<boolean>;
  onCancel: (runId: string) => void;
  onApproval: (
    runId: string,
    approvalId: string,
    decision: AgentApprovalDecision,
  ) => void;
  terminalOpen: boolean;
  onTerminalOpenChange: (open: boolean) => void;
  preparingSession: boolean;
  preparationError?: string;
};

function WorktreeDetails({ worktree }: { worktree: SessionWorktree }) {
  return (
    <div className="space-y-2 px-2 py-1.5">
      <div>
        <p className="text-[10px] font-medium text-muted-foreground">Branch</p>
        <p className="truncate font-mono text-[10px] text-foreground">
          {worktree.branch}
        </p>
      </div>
      <div>
        <p className="text-[10px] font-medium text-muted-foreground">
          Created from
        </p>
        <p className="truncate font-mono text-[10px] text-foreground">
          {worktree.baseRef}
        </p>
      </div>
      <div>
        <p className="text-[10px] font-medium text-muted-foreground">Path</p>
        <p
          className="truncate font-mono text-[10px] text-foreground"
          title={worktree.path}
        >
          {worktree.path}
        </p>
      </div>
    </div>
  );
}

function WorktreeDetailsMenu({ worktree }: { worktree: SessionWorktree }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
        className="mr-1 h-7 max-w-44 gap-1.5 px-2 text-[11px] text-muted-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
        aria-label={`Worktree: ${worktree.name}`}
      >
        <GitFork className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{worktree.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase">
            Session worktree
          </DropdownMenuLabel>
          <WorktreeDetails worktree={worktree} />
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="h-8 px-2 text-xs"
          onClick={() => void navigator.clipboard.writeText(worktree.path)}
        >
          <Copy aria-hidden="true" />
          Copy path
        </DropdownMenuItem>
        <DropdownMenuItem
          className="h-8 px-2 text-xs"
          onClick={() => void window.electron.revealWorktree(worktree.path)}
        >
          <FolderOpen aria-hidden="true" />
          Show in folder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionLocationPicker({
  session,
  onChange,
}: {
  session: ChatSession;
  onChange: (mode: SessionExecutionMode) => void;
}) {
  const mode = session.executionMode ?? "local";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
        className="h-7 min-w-0 max-w-40 justify-start gap-1.5 rounded-full bg-background/80 px-2.5 text-[11px] font-medium text-foreground ring-1 ring-border/70 hover:bg-background data-popup-open:bg-background"
        aria-label={
          mode === "worktree" ? "Session: Worktree" : "Session: Local"
        }
      >
        {mode === "worktree" ? (
          <GitFork className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Monitor className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">
          {mode === "worktree" ? "Worktree" : "Local"}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72"
      >
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if ((value === "local" || value === "worktree") && value !== mode) {
              onChange(value);
            }
          }}
        >
          <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
            Session location
          </DropdownMenuLabel>
          <DropdownMenuRadioItem
            value="local"
            closeOnClick
            className="items-start gap-2 py-2 pr-8 pl-2"
          >
            <Monitor className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-xs font-medium">Local</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                Work directly in the project folder.
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="worktree"
            closeOnClick
            className="items-start gap-2 py-2 pr-8 pl-2"
          >
            <GitFork className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-xs font-medium">Worktree</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                Create an isolated branch from the current commit when you send.
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceHeader({
  project,
  session,
  terminalOpen,
  onTerminalOpenChange,
}: Pick<
  ChatWorkspaceProps,
  "project" | "session" | "terminalOpen" | "onTerminalOpenChange"
>) {
  const { state } = useSidebar();
  const isMac = window.electron.platform === "darwin";
  const shortcut = isMac ? "⌘J" : "Ctrl+J";

  return (
    <header className="relative flex h-12 shrink-0 items-center border-b bg-background">
      <div className="app-drag absolute inset-0" />
      <div
        className={cn(
          "pointer-events-none relative z-10 flex min-w-0 flex-1 items-center pr-2 transition-[padding] duration-200 ease-linear motion-reduce:transition-none",
          state === "collapsed" ? (isMac ? "pl-32" : "pl-14") : "pl-4",
        )}
      >
        <div className="min-w-0">
          <p className="truncate text-[13px] leading-none font-medium tracking-[-0.01em]">
            {session?.title ?? project?.name ?? ""}
          </p>
        </div>
      </div>
      <div className="app-no-drag relative z-10 flex shrink-0 items-center pr-2.5">
        {session?.worktree ? (
          <WorktreeDetailsMenu worktree={session.worktree} />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            "size-7 text-muted-foreground",
            terminalOpen
              ? "bg-accent text-foreground"
              : "hover:bg-accent hover:text-foreground",
          )}
          aria-label={`${terminalOpen ? "Close" : "Open"} terminal panel`}
          aria-pressed={terminalOpen}
          title={`${terminalOpen ? "Close" : "Open"} terminal (${shortcut})`}
          onClick={() => onTerminalOpenChange(!terminalOpen)}
        >
          <SquareTerminal className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}

function ThinkingDots() {
  return (
    <span className="flex size-4 items-center gap-0.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="thinking-dot size-1 rounded-full bg-current"
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
  );
}

function splitResponseChunks(chunks: string[]) {
  let offset = 0;
  return chunks.flatMap((chunk) =>
    (chunk.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^\n]+\n+|\n+|.+$/g) ?? [chunk]).map(
      (text) => {
        const segment = { offset, text };
        offset += text.length;
        return segment;
      },
    ),
  );
}

function MarkdownResponse({ children }: { children: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function ActivityIcon({ activity }: { activity: AgentActivity }) {
  if (activity.status === "running") {
    return <ThinkingDots />;
  }
  if (activity.status === "error") {
    return <AlertCircle className="size-3.5" />;
  }
  if (activity.kind === "reasoning") {
    return <Brain className="size-3.5" />;
  }
  if (activity.kind === "command") {
    if (activity.label.startsWith("Read ")) {
      return <BookOpen className="size-3.5" />;
    }
    if (activity.label.startsWith("Searched ")) {
      return <Search className="size-3.5" />;
    }
    return <SquareTerminal className="size-3.5" />;
  }
  if (activity.kind === "file-change") {
    return <FilePenLine className="size-3.5" />;
  }
  if (activity.kind === "web-search") {
    return <Globe2 className="size-3.5" />;
  }
  if (activity.kind === "tool") {
    return <Wrench className="size-3.5" />;
  }
  return <Check className="size-3.5" />;
}

function ActivityDetail({ activity }: { activity: AgentActivity }) {
  const detail = activity.detail?.trim();
  const output = activity.output?.trim();
  if (!detail && !output) {
    return null;
  }

  if (activity.kind === "reasoning") {
    return detail ? (
      <div className="execution-reasoning mt-1.5 max-w-2xl text-[12px] leading-5 text-muted-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail}</ReactMarkdown>
      </div>
    ) : null;
  }

  if (activity.kind === "command") {
    return (
      <div className="mt-2 min-w-0 overflow-hidden rounded-xl border border-border/80 bg-muted/35">
        <div className="px-3.5 pt-2.5 text-[11px] font-medium text-muted-foreground">
          Shell
        </div>
        <pre className="execution-detail max-h-72 overflow-auto px-3.5 pt-3 pb-3.5 font-mono text-[11px] leading-[1.65] whitespace-pre-wrap text-foreground/75">
          {detail ? `$ ${detail}` : ""}
          {detail && output ? "\n\n" : ""}
          {output ?? ""}
        </pre>
      </div>
    );
  }

  return (
    <div className="mt-2 grid min-w-0 gap-2">
      {detail ? (
        <div className="min-w-0">
          <span className="mb-1 block text-[9px] font-semibold tracking-[0.08em] text-muted-foreground/70 uppercase">
            {activity.kind === "file-change" ? "Changes" : "Details"}
          </span>
          <pre className="execution-detail max-h-44 overflow-auto rounded-md border border-border/70 bg-muted/45 px-2.5 py-2 font-mono text-[10px] leading-[1.55] whitespace-pre-wrap text-foreground/80">
            {detail}
          </pre>
        </div>
      ) : null}
      {output ? (
        <div className="min-w-0">
          <span className="mb-1 block text-[9px] font-semibold tracking-[0.08em] text-muted-foreground/70 uppercase">
            Output
          </span>
          <pre className="execution-detail max-h-52 overflow-auto rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 font-mono text-[10px] leading-[1.55] whitespace-pre-wrap text-muted-foreground">
            {output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function releaseMessageScrollerAnchor(element: HTMLElement) {
  const viewport = element
    .closest('[data-slot="message-scroller"]')
    ?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
  viewport?.dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, deltaY: 0 }),
  );
}

function ToolCall({ activity }: { activity: AgentActivity }) {
  const hasDetails = Boolean(
    activity.detail?.trim() || activity.output?.trim(),
  );

  if (!hasDetails) {
    return (
      <Marker
        role="status"
        className={cn(
          "min-w-0 gap-2 py-0.5 text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none",
          activity.status === "error" &&
            "text-destructive hover:text-destructive",
        )}
      >
        <MarkerIcon>
          <ActivityIcon activity={activity} />
        </MarkerIcon>
        <MarkerContent
          className={cn(
            "truncate font-medium",
            activity.status === "running" && "shimmer",
          )}
        >
          {activity.label}
          {activity.status === "running" ? "…" : ""}
        </MarkerContent>
      </Marker>
    );
  }

  return (
    <Collapsible defaultOpen={false} className="min-w-0">
      <CollapsibleTrigger
        type="button"
        className={cn(
          "group/tool-call -ml-1 block max-w-full rounded-md px-1 py-0.5 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none",
          activity.status === "error" &&
            "text-destructive hover:text-destructive",
        )}
        onClick={(event) => releaseMessageScrollerAnchor(event.currentTarget)}
      >
        <Marker
          role="status"
          className="w-auto max-w-full min-w-0 gap-2 text-[13px] leading-5 text-inherit"
        >
          <MarkerIcon>
            <ActivityIcon activity={activity} />
          </MarkerIcon>
          <MarkerContent
            className={cn(
              "truncate font-medium",
              activity.status === "running" && "shimmer",
            )}
          >
            {activity.label}
            {activity.status === "running" ? "…" : ""}
          </MarkerContent>
          <ChevronDown className="size-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover/tool-call:opacity-100 group-focus-visible/tool-call:opacity-100 group-data-[panel-open]/tool-call:rotate-180 group-data-[panel-open]/tool-call:opacity-100 motion-reduce:transition-none" />
        </Marker>
      </CollapsibleTrigger>
      <CollapsibleContent className="execution-collapse execution-tool-detail min-w-0 pl-6">
        <ActivityDetail activity={activity} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function activitySummary(activities: AgentActivity[]) {
  const hasFileChanges = activities.some(
    (activity) => activity.kind === "file-change",
  );
  const hasReads = activities.some(
    (activity) =>
      activity.kind === "command" && activity.label.startsWith("Read "),
  );
  const hasFileLists = activities.some(
    (activity) =>
      activity.kind === "command" && activity.label.startsWith("Listed "),
  );
  const hasProjectSearches = activities.some(
    (activity) =>
      activity.kind === "command" && activity.label.startsWith("Searched "),
  );
  const hasWebSearches = activities.some(
    (activity) => activity.kind === "web-search",
  );
  const commandCount = activities.filter(
    (activity) =>
      activity.kind === "command" &&
      !activity.label.startsWith("Read ") &&
      !activity.label.startsWith("Listed ") &&
      !activity.label.startsWith("Searched "),
  ).length;
  const toolCount = activities.filter(
    (activity) => activity.kind === "tool" || activity.kind === "other",
  ).length;
  const phrases = [
    hasFileChanges ? "edited files" : null,
    hasReads ? "read files" : null,
    hasFileLists ? "listed files" : null,
    hasProjectSearches ? "searched the project" : null,
    hasWebSearches ? "searched the web" : null,
    toolCount > 0 ? `used ${toolCount === 1 ? "a tool" : "tools"}` : null,
    commandCount > 0
      ? `ran ${commandCount === 1 ? "a command" : "commands"}`
      : null,
  ].filter((phrase): phrase is string => phrase !== null);
  const summary = phrases.join(", ") || "worked on the request";
  return `${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}`;
}

function ActivitySummaryIcon({ activities }: { activities: AgentActivity[] }) {
  if (activities.some((activity) => activity.kind === "file-change")) {
    return <FilePenLine className="size-3.5" />;
  }
  if (activities.some((activity) => activity.kind === "command")) {
    return <SquareTerminal className="size-3.5" />;
  }
  if (activities.some((activity) => activity.kind === "web-search")) {
    return <Globe2 className="size-3.5" />;
  }
  return <Wrench className="size-3.5" />;
}

function ExecutionTrace({
  message,
  activities,
}: {
  message: ChatMessage;
  activities: AgentActivity[];
}) {
  const isActive =
    message.status === "thinking" || message.status === "streaming";
  const reasoningActivities = activities.filter(
    (activity) => activity.kind === "reasoning",
  );
  const actionActivities = activities.filter(
    (activity) => activity.kind !== "reasoning",
  );
  const currentReasoning = [...reasoningActivities].reverse()[0];

  if (actionActivities.length === 0) {
    return isActive ? (
      <Marker role="status" className="execution-activity w-fit text-xs">
        <MarkerIcon>
          <ThinkingDots />
        </MarkerIcon>
        <MarkerContent className="shimmer">
          {currentReasoning?.label ??
            (message.status === "streaming" ? "Writing response" : "Thinking")}
          …
        </MarkerContent>
      </Marker>
    ) : null;
  }

  return (
    <Collapsible defaultOpen={false} className="execution-activity min-w-0">
      <CollapsibleTrigger
        type="button"
        className="group/execution-trigger -ml-1 block max-w-full rounded-md px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={(event) => releaseMessageScrollerAnchor(event.currentTarget)}
      >
        <Marker className="w-auto max-w-full gap-2 text-[13px] leading-5">
          <MarkerIcon>
            <ActivitySummaryIcon activities={actionActivities} />
          </MarkerIcon>
          <MarkerContent className={cn("truncate", isActive && "shimmer")}>
            {activitySummary(actionActivities)}
            {isActive ? "…" : ""}
          </MarkerContent>
          <ChevronDown className="size-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-200 group-hover/execution-trigger:opacity-100 group-focus-visible/execution-trigger:opacity-100 group-data-[panel-open]/execution-trigger:rotate-180 group-data-[panel-open]/execution-trigger:opacity-100 motion-reduce:transition-none" />
        </Marker>
      </CollapsibleTrigger>
      <CollapsibleContent className="execution-collapse execution-trace min-w-0 pl-0.5">
        <ScrollArea
          className="max-h-50 min-w-0"
          viewportClassName="h-auto max-h-50 scroll-fade-y"
        >
          <div className="grid min-w-0 gap-0 pt-1.5 pb-0.5">
            {actionActivities.map((activity) => (
              <ToolCall key={activity.id} activity={activity} />
            ))}
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}

function AgentResponse({ message }: { message: ChatMessage }) {
  const activities = (message.activities ?? []).filter(
    (activity) =>
      !(activity.id === "item_0" && activity.label.toLowerCase() === "error"),
  );
  const animatedChunks = useMemo(
    () => splitResponseChunks(message.chunks),
    [message.chunks],
  );

  return (
    <Message>
      <MessageContent className="gap-2.5">
        <ExecutionTrace message={message} activities={activities} />

        {message.status === "error" ? (
          <Marker
            role="status"
            variant="border"
            className="text-xs text-destructive"
          >
            <MarkerIcon>
              <AlertCircle />
            </MarkerIcon>
            <MarkerContent>The agent stopped before finishing.</MarkerContent>
          </Marker>
        ) : null}

        {message.status === "cancelled" ? (
          <Marker variant="border" className="text-xs">
            <MarkerIcon>
              <Square />
            </MarkerIcon>
            <MarkerContent>Stopped</MarkerContent>
          </Marker>
        ) : null}

        {message.content ? (
          message.status === "complete" ? (
            <MarkdownResponse>{message.content}</MarkdownResponse>
          ) : (
            <div className="streaming-response text-[14px] leading-6 whitespace-pre-wrap">
              {animatedChunks.map((chunk) => (
                <span
                  key={`${message.id}-${chunk.offset}`}
                  className="response-chunk"
                >
                  {chunk.text}
                </span>
              ))}
            </div>
          )
        ) : null}
      </MessageContent>
    </Message>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <Message align="end">
      <MessageContent className="w-auto max-w-[min(78%,42rem)] flex-none">
        <div className="rounded-2xl rounded-br-md bg-user-message px-4 py-2.5 text-[14px] leading-6 text-user-message-foreground shadow-[0_1px_1px_rgb(0_0_0/0.06)] whitespace-pre-wrap">
          {message.content}
        </div>
      </MessageContent>
    </Message>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-16 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-5 flex size-10 items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-sm">
          {icon}
        </div>
        <h1 className="text-lg font-semibold tracking-[-0.025em]">{title}</h1>
        {description ? (
          <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}

type AgentModelGroup = {
  value: string;
  items: AgentModel[];
};

function groupModels(models: AgentModel[]): AgentModelGroup[] {
  const groups = new Map<string, AgentModel[]>();
  for (const model of models) {
    groups.set(model.group, [...(groups.get(model.group) ?? []), model]);
  }
  return [...groups.entries()].map(([value, items]) => ({ value, items }));
}

const reasoningEffortLabels: Record<AgentReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Maximum",
  ultra: "Ultra",
};

const speedLabels: Record<AgentSpeed, string> = {
  standard: "Standard",
  fast: "Fast",
};

function compactModelLabel(model: AgentModel, includeProvider = false) {
  let label = model.label;
  if (model.provider === "codex") {
    label = label.replace(/^GPT-/i, "").replaceAll("-", " ");
  } else {
    label = label.replace(/\s*\(latest\)$/i, "");
  }
  return includeProvider && model.provider !== "codex"
    ? `${model.group} ${label}`
    : label;
}

function ModelSettingTrigger({
  label,
  value,
  disabled = false,
  className,
  ...props
}: {
  label: string;
  value: string;
  disabled?: boolean;
} & ComponentPropsWithRef<"button">) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      {...props}
      disabled={disabled}
      className={cn("group/model-setting w-full justify-start", className)}
    >
      <span className="font-medium text-foreground">{label}</span>
      <span className="ml-auto max-w-40 truncate text-muted-foreground group-hover/model-setting:text-foreground group-focus-visible/model-setting:text-foreground">
        {value}
      </span>
      <ChevronRight
        className="shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </Button>
  );
}

function ModelPicker({
  provider,
  model,
  reasoningEffort,
  speed,
  models,
  loading,
  onChange,
}: {
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  speed?: AgentSpeed;
  models: AgentModel[];
  loading: boolean;
  onChange: (selection: AgentModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const groups = useMemo(() => groupModels(models), [models]);
  const selectedModel = model
    ? (models.find(
        (availableModel) =>
          availableModel.provider === (provider ?? "gemini") &&
          availableModel.model === model,
      ) ?? {
        provider: provider ?? "gemini",
        model,
        label: model,
        group: provider === "codex" ? "Codex" : "Other",
      })
    : (models.find((availableModel) => availableModel.provider === "gemini") ??
      models[0] ??
      null);

  const effortOptions = selectedModel?.reasoningEfforts ?? [];
  const selectedEffort = effortOptions.includes(
    reasoningEffort as AgentReasoningEffort,
  )
    ? reasoningEffort
    : selectedModel?.defaultReasoningEffort;
  const speedOptions = selectedModel?.speeds ?? ["standard"];
  const selectedSpeed = speedOptions.includes(speed as AgentSpeed)
    ? (speed as AgentSpeed)
    : (selectedModel?.defaultSpeed ?? speedOptions[0] ?? "standard");
  const supportsFastSpeed = speedOptions.includes("fast");
  const fastSpeedSelected = selectedSpeed === "fast";
  const selectedEffortIndex = selectedEffort
    ? effortOptions.indexOf(selectedEffort)
    : -1;
  const summary = selectedModel
    ? [
        compactModelLabel(selectedModel, true),
        selectedEffort ? reasoningEffortLabels[selectedEffort] : null,
        selectedSpeed === "fast" ? speedLabels.fast : null,
      ]
        .filter(Boolean)
        .join(" ")
    : loading
      ? "Finding models…"
      : "No models";

  function selectModel(nextModel: AgentModel) {
    const nextEfforts = nextModel.reasoningEfforts ?? [];
    const nextSpeeds = nextModel.speeds ?? ["standard"];
    onChange({
      provider: nextModel.provider,
      model: nextModel.model,
      reasoningEffort: nextEfforts.includes(
        selectedEffort as AgentReasoningEffort,
      )
        ? selectedEffort
        : nextModel.defaultReasoningEffort,
      speed: nextSpeeds.includes(selectedSpeed) ? selectedSpeed : nextSpeeds[0],
    });
  }

  function selectEffort(nextEffort: AgentReasoningEffort) {
    if (!selectedModel) {
      return;
    }
    onChange({
      provider: selectedModel.provider,
      model: selectedModel.model,
      reasoningEffort: nextEffort,
      speed: selectedSpeed,
    });
  }

  function selectSpeed(nextSpeed: AgentSpeed) {
    if (!selectedModel) {
      return;
    }
    onChange({
      provider: selectedModel.provider,
      model: selectedModel.model,
      reasoningEffort: selectedEffort,
      speed: nextSpeed,
    });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setAdvanced(false);
        }
      }}
    >
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
        aria-label={`Model settings: ${summary}`}
        aria-busy={loading}
        className="min-w-0 max-w-72 justify-start text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        <span className="min-w-0 flex-1 truncate text-left">{summary}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
      </PopoverTrigger>

      <PopoverContent side="top" align="end">
        {advanced ? (
          <div className="grid gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <ModelSettingTrigger
                    label="Model"
                    value={
                      selectedModel
                        ? compactModelLabel(selectedModel)
                        : "Unavailable"
                    }
                    disabled={models.length === 0}
                  />
                }
              />
              <DropdownMenuContent side="right" align="start">
                {groups.map((group, groupIndex) => (
                  <DropdownMenuGroup key={group.value}>
                    {groups.length > 1 ? (
                      <DropdownMenuLabel>{group.value}</DropdownMenuLabel>
                    ) : null}
                    <DropdownMenuRadioGroup
                      value={
                        selectedModel
                          ? `${selectedModel.provider}:${selectedModel.model}`
                          : ""
                      }
                      onValueChange={(value) => {
                        const nextModel = models.find(
                          (availableModel) =>
                            `${availableModel.provider}:${availableModel.model}` ===
                            value,
                        );
                        if (nextModel) {
                          selectModel(nextModel);
                        }
                      }}
                    >
                      {group.items.map((availableModel) => (
                        <DropdownMenuRadioItem
                          key={`${availableModel.provider}:${availableModel.model}`}
                          value={`${availableModel.provider}:${availableModel.model}`}
                          closeOnClick
                        >
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {compactModelLabel(availableModel)}
                          </span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    {groupIndex < groups.length - 1 ? (
                      <DropdownMenuSeparator />
                    ) : null}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <ModelSettingTrigger
                    label="Effort"
                    value={
                      selectedEffort
                        ? reasoningEffortLabels[selectedEffort]
                        : "Automatic"
                    }
                    disabled={effortOptions.length === 0}
                  />
                }
              />
              <DropdownMenuContent side="right" align="start">
                <DropdownMenuRadioGroup
                  value={selectedEffort ?? ""}
                  onValueChange={(value) =>
                    selectEffort(value as AgentReasoningEffort)
                  }
                >
                  {effortOptions.map((effort) => (
                    <DropdownMenuRadioItem
                      key={effort}
                      value={effort}
                      closeOnClick
                    >
                      {reasoningEffortLabels[effort]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <ModelSettingTrigger
                    label="Speed"
                    value={speedLabels[selectedSpeed]}
                    disabled={speedOptions.length < 2}
                  />
                }
              />
              <DropdownMenuContent side="right" align="start">
                <DropdownMenuRadioGroup
                  value={selectedSpeed}
                  onValueChange={(value) => selectSpeed(value as AgentSpeed)}
                >
                  {speedOptions.map((availableSpeed) => (
                    <DropdownMenuRadioItem
                      key={availableSpeed}
                      value={availableSpeed}
                      closeOnClick
                    >
                      <span>{speedLabels[availableSpeed]}</span>
                      {availableSpeed === "fast" ? (
                        <Zap
                          className="ml-1 size-3.5 text-primary"
                          aria-hidden="true"
                        />
                      ) : null}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Separator className="my-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
              onClick={() => setAdvanced(false)}
            >
              Advanced
              <ChevronDown className="rotate-180" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setAdvanced(true)}
              >
                Advanced
                <ChevronRight aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant={fastSpeedSelected ? "secondary" : "ghost"}
                size="icon-sm"
                disabled={!supportsFastSpeed}
                aria-label={
                  supportsFastSpeed
                    ? fastSpeedSelected
                      ? "Use standard speed"
                      : "Use fast speed"
                    : "Fast speed unavailable for this model"
                }
                aria-pressed={fastSpeedSelected}
                title={
                  supportsFastSpeed
                    ? fastSpeedSelected
                      ? "Use standard speed"
                      : "Use fast speed"
                    : "Fast speed unavailable for this model"
                }
                onClick={() =>
                  selectSpeed(fastSpeedSelected ? "standard" : "fast")
                }
              >
                <Zap
                  className={cn(fastSpeedSelected && "fill-current")}
                  aria-hidden="true"
                />
              </Button>
            </div>

            {effortOptions.length > 1 ? (
              <div className="grid gap-2 px-1 pb-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">Reasoning</span>
                  <span className="text-muted-foreground">
                    {selectedEffort
                      ? reasoningEffortLabels[selectedEffort]
                      : "Automatic"}
                  </span>
                </div>
                <div className="relative flex h-8 items-center">
                  <div
                    className="pointer-events-none absolute inset-x-0 top-1/2 z-30 flex -translate-y-1/2 items-center justify-between px-px"
                    aria-hidden="true"
                  >
                    {effortOptions.map((effort, index) => (
                      <span
                        key={effort}
                        className={cn(
                          "size-1.5 rounded-full bg-primary-foreground/55",
                          index === selectedEffortIndex && "opacity-0",
                        )}
                      />
                    ))}
                  </div>
                  <Slider
                    value={[Math.max(0, selectedEffortIndex)]}
                    min={0}
                    max={effortOptions.length - 1}
                    step={1}
                    aria-label={`Reasoning effort: ${selectedEffort ? reasoningEffortLabels[selectedEffort] : "Automatic"}`}
                    onValueChange={(value) => {
                      const index = Array.isArray(value) ? value[0] : value;
                      const nextEffort = effortOptions[index ?? 0];
                      if (nextEffort) {
                        selectEffort(nextEffort);
                      }
                    }}
                    className="relative z-20 [&_[data-slot=slider-track]]:h-3 [&_[data-slot=slider-thumb]]:size-6 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:shadow-sm"
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                {selectedModel
                  ? `${compactModelLabel(selectedModel)} sets effort automatically.`
                  : "Choose a model in Advanced."}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AccessModeIcon({ mode }: { mode: AgentAccessMode }) {
  if (mode === "auto") {
    return <ShieldCheck aria-hidden="true" />;
  }
  if (mode === "accept-edits") {
    return <FilePenLine aria-hidden="true" />;
  }
  if (mode === "plan") {
    return <ListChecks aria-hidden="true" />;
  }
  if (mode === "full-access") {
    return <ShieldOff aria-hidden="true" />;
  }
  return <ShieldQuestion aria-hidden="true" />;
}

function AccessModePicker({
  provider,
  mode,
  onChange,
}: {
  provider: AgentProvider;
  mode: AgentAccessMode;
  onChange: (mode: AgentAccessMode) => void;
}) {
  const options = getAgentAccessModes(provider);
  const selectedMode = resolveAgentAccessMode(provider, mode);
  const selectedOption = options.find(
    (option) => option.value === selectedMode,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
        className="h-7 min-w-0 max-w-36 justify-start gap-1.5 px-2 text-[11px] text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
        aria-label={`Access mode: ${selectedOption?.label ?? selectedMode}`}
      >
        <span className="size-3.5 shrink-0 [&>svg]:size-3.5">
          <AccessModeIcon mode={selectedMode} />
        </span>
        <span className="truncate">{selectedOption?.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72"
      >
        <DropdownMenuRadioGroup
          value={selectedMode}
          onValueChange={(value) => {
            if (typeof value === "string") {
              onChange(
                resolveAgentAccessMode(provider, value as AgentAccessMode),
              );
            }
          }}
        >
          <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
            Access for {getAgentProviderLabel(provider)}
          </DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              closeOnClick
              className="items-start gap-2 py-2 pr-8 pl-2"
            >
              <span
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center [&>svg]:size-3.5",
                  option.value === "full-access" && "text-destructive",
                )}
              >
                <AccessModeIcon mode={option.value} />
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-xs font-medium",
                    option.value === "full-access" && "text-destructive",
                  )}
                >
                  {option.label}
                </span>
                <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectPicker({
  project,
  projects,
  placement,
  onChange,
  onCreateProject,
}: {
  project: Project | null;
  projects: Project[];
  placement: "card" | "prompt";
  onChange: (projectId: string | null) => void;
  onCreateProject: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Combobox
      items={projects}
      value={project}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(nextProject: Project | null) => {
        if (nextProject) {
          onChange(nextProject.id);
        }
      }}
      itemToStringLabel={(item: Project) => item.name}
      itemToStringValue={(item: Project) => item.id}
      isItemEqualToValue={(item, value) => item.id === value?.id}
    >
      <div
        className={cn(
          "group/project-picker relative inline-flex min-w-0 max-w-[70%]",
          placement === "card" && !project && "min-w-28",
        )}
      >
        <ComboboxTrigger
          render={<button type="button" />}
          aria-label={project ? `Project: ${project.name}` : "Choose project"}
          className={cn(
            "inline-flex min-w-0 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            placement === "card"
              ? cn(
                  "h-7 max-w-full justify-start gap-1.5 rounded-full px-2.5 text-[11px] font-medium ring-1 [&>svg:last-child]:hidden",
                  project
                    ? "bg-background/80 text-foreground ring-border/70 hover:bg-background data-popup-open:bg-background"
                    : "bg-background/50 text-muted-foreground/80 ring-border/50 hover:bg-background/80 hover:text-muted-foreground data-popup-open:bg-background data-popup-open:text-foreground",
                )
              : "h-auto max-w-[min(22rem,68vw)] translate-y-px items-baseline gap-0 rounded-md px-0.5 py-0 font-semibold text-primary underline decoration-primary/30 decoration-1 underline-offset-4 hover:bg-primary/10 hover:decoration-primary/60 [&>svg]:hidden",
          )}
        >
          {placement === "card" && project ? (
            <Folder
              className="size-3.5 shrink-0 transition-opacity group-hover/project-picker:opacity-0"
              aria-hidden="true"
            />
          ) : null}
          <span className="min-w-0 truncate">
            <ComboboxValue>{project?.name ?? "Choose project"}</ComboboxValue>
          </span>
        </ComboboxTrigger>
        {placement === "card" && project ? (
          <button
            type="button"
            className="absolute top-1/2 left-1.5 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-background/95 text-muted-foreground opacity-0 shadow-sm ring-1 ring-border/70 transition-[opacity,color,background-color] group-hover/project-picker:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Don't work in a project"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onChange(null);
            }}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <ComboboxContent
        side={placement === "card" ? "top" : "bottom"}
        className="w-72 min-w-72"
      >
        <ComboboxInput
          className="m-0! rounded-none border-0! bg-transparent! shadow-none ring-0! focus-within:border-transparent! focus-within:ring-0!"
          placeholder="Search projects…"
          aria-label="Search projects"
          showTrigger={false}
        />
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
        <ComboboxList>
          {(availableProject: Project) => (
            <ComboboxItem
              key={availableProject.id}
              value={availableProject}
              className="min-h-8 px-2 py-1.5 text-xs"
            >
              <Folder
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {availableProject.name}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxSeparator />
        <div className="grid gap-0.5 p-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start px-2 text-xs"
            onClick={() => {
              setOpen(false);
              onCreateProject();
            }}
          >
            <Plus aria-hidden="true" />
            New project
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start px-2 text-xs text-muted-foreground"
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
          >
            <X aria-hidden="true" />
            Don't work in a project
          </Button>
        </div>
      </ComboboxContent>
    </Combobox>
  );
}

function NewSessionPrompt({
  project,
  projects,
  onProjectChange,
  onCreateProject,
}: {
  project: Project | null;
  projects: Project[];
  onProjectChange: (projectId: string | null) => void;
  onCreateProject: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-4 text-center">
      <h1 className="text-xl font-semibold tracking-[-0.035em]">
        {project ? (
          <>
            What should we build in{" "}
            <ProjectPicker
              project={project}
              projects={projects}
              placement="prompt"
              onChange={onProjectChange}
              onCreateProject={onCreateProject}
            />
            {"?"}
          </>
        ) : (
          "What should we build?"
        )}
      </h1>
    </div>
  );
}

function ApprovalPrompt({
  approval,
  onRespond,
}: {
  approval: AgentApprovalRequest;
  onRespond: (decision: AgentApprovalDecision) => void;
}) {
  return (
    <fieldset
      className="min-w-0 border-0 p-0"
      aria-label={approval.title}
      aria-live="polite"
    >
      <div className="space-y-3 px-3.5 pt-3.5 pb-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-700 dark:text-amber-300">
            {approval.kind === "command" ? (
              <SquareTerminal className="size-4" aria-hidden="true" />
            ) : (
              <FilePenLine className="size-4" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-5 font-semibold">
              {approval.title}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              Review the requested action before Codex continues.
            </p>
          </div>
        </div>

        {approval.reason ? (
          <p className="rounded-lg border bg-muted/45 px-3 py-2 text-xs leading-5 text-muted-foreground">
            {approval.reason}
          </p>
        ) : null}

        {approval.command ? (
          <div className="overflow-hidden rounded-lg border bg-muted/45">
            {approval.cwd ? (
              <p className="truncate border-b px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
                {approval.cwd}
              </p>
            ) : null}
            <pre className="max-h-32 overflow-auto px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap text-foreground">
              {approval.command}
            </pre>
          </div>
        ) : null}

        {approval.files?.length ? (
          <div className="max-h-36 overflow-auto rounded-lg border bg-muted/45">
            {approval.files.map((file) => (
              <div
                key={`${file.change}:${file.path}`}
                className="flex min-w-0 items-center gap-2 border-b px-3 py-2 last:border-b-0"
              >
                <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase ring-1 ring-border">
                  {file.change}
                </span>
                <span className="min-w-0 truncate font-mono text-[11px]">
                  {file.path}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <CardFooter className="min-h-11 justify-between gap-2 border-t bg-muted/25 px-2.5 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground hover:text-destructive"
          onClick={() => onRespond("deny")}
        >
          Deny
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          {approval.canApproveForSession ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs shadow-none"
              onClick={() => onRespond("approve-session")}
            >
              Allow for task
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            onClick={() => onRespond("approve")}
          >
            Approve once
          </Button>
        </div>
      </CardFooter>
    </fieldset>
  );
}

const compactTokenFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const ESCAPE_STOP_CONFIRMATION_MS = 1_000;

function ContextUsageIndicator({
  usage,
  contextWindow,
}: {
  usage?: AgentUsage;
  contextWindow?: number;
}) {
  const maxTokens = usage?.contextWindow ?? contextWindow;
  const usedTokens = usage?.usedTokens;
  const ratio =
    maxTokens && usedTokens !== undefined ? usedTokens / maxTokens : 0;
  const percentage = Math.min(100, Math.round(Math.max(0, ratio) * 100));
  const fillPercentage = Math.min(100, Math.max(0, ratio * 100));
  const summary =
    maxTokens && usedTokens !== undefined
      ? `${compactTokenFormatter.format(usedTokens)} of ${compactTokenFormatter.format(maxTokens)} tokens used`
      : "Context usage unavailable";

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={180}
        closeDelay={100}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
            aria-label={summary}
          />
        }
      >
        {maxTokens && usedTokens !== undefined ? (
          <span
            className="size-3.5 rounded-full ring-1 ring-foreground/15 ring-inset"
            style={{
              background: `conic-gradient(currentColor ${fillPercentage}%, color-mix(in oklab, currentColor 16%, transparent) 0)`,
            }}
            aria-hidden="true"
          />
        ) : (
          <ChartPie className="size-3.5" aria-hidden="true" />
        )}
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72 p-3.5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium">Context usage</p>
            <p className="mt-1 text-lg leading-none font-semibold tracking-[-0.025em] tabular-nums">
              {usedTokens === undefined
                ? "—"
                : compactTokenFormatter.format(usedTokens)}
              {maxTokens ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  / {compactTokenFormatter.format(maxTokens)}
                </span>
              ) : null}
            </p>
          </div>
          <span className="rounded-md bg-muted px-1.5 py-1 text-[10px] leading-none font-medium text-muted-foreground tabular-nums">
            {maxTokens && usedTokens !== undefined ? `${percentage}%` : "—"}
          </span>
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${fillPercentage}%` }}
          />
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function Composer({
  isRunning,
  activeRunId,
  approval,
  provider,
  model,
  usage,
  contextWindow,
  hasAgentSession,
  models,
  modelsLoading,
  accessMode,
  session,
  project,
  projects,
  isNewSession,
  preparingSession,
  preparationError,
  onProjectChange,
  onCreateProject,
  onModelChange,
  onAccessModeChange,
  onExecutionModeChange,
  onSend,
  onCancel,
  onApproval,
}: {
  isRunning: boolean;
  activeRunId?: string;
  approval?: AgentApprovalRequest;
  provider?: AgentProvider;
  model?: string;
  usage?: AgentUsage;
  contextWindow?: number;
  hasAgentSession: boolean;
  models: AgentModel[];
  modelsLoading: boolean;
  accessMode: AgentAccessMode;
  session: ChatSession;
  project: Project | null;
  projects: Project[];
  isNewSession: boolean;
  preparingSession: boolean;
  preparationError?: string;
  onProjectChange: (projectId: string | null) => void;
  onCreateProject: () => void;
  onModelChange: (selection: AgentModelSelection) => void;
  onAccessModeChange: (mode: AgentAccessMode) => void;
  onExecutionModeChange: (mode: SessionExecutionMode) => void;
  onSend: ChatWorkspaceProps["onSend"];
  onCancel: (runId: string) => void;
  onApproval: ChatWorkspaceProps["onApproval"];
}) {
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEscapeStopArmed, setIsEscapeStopArmed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    setIsEscapeStopArmed(false);

    if (!isRunning || !activeRunId || approval) {
      return;
    }

    const runId = activeRunId;
    let escapeStopArmed = false;
    let resetTimeout: number | undefined;

    function resetEscapeStop() {
      escapeStopArmed = false;
      setIsEscapeStopArmed(false);
      if (resetTimeout !== undefined) {
        window.clearTimeout(resetTimeout);
        resetTimeout = undefined;
      }
    }

    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.repeat) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (escapeStopArmed) {
        resetEscapeStop();
        onCancelRef.current(runId);
        return;
      }

      escapeStopArmed = true;
      setIsEscapeStopArmed(true);
      resetTimeout = window.setTimeout(
        resetEscapeStop,
        ESCAPE_STOP_CONFIRMATION_MS,
      );
    }

    window.addEventListener("keydown", handleEscape, true);
    return () => {
      window.removeEventListener("keydown", handleEscape, true);
      resetEscapeStop();
    };
  }, [activeRunId, approval, isRunning]);

  async function submit() {
    const prompt = draft.trim();
    if (!prompt || isRunning || isSubmitting || preparingSession) {
      return;
    }
    setIsSubmitting(true);
    try {
      const sent = await onSend(prompt);
      if (sent) {
        setDraft("");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="shrink-0 px-4 pb-3 sm:px-8 sm:pb-4">
      <div className="relative mx-auto w-full min-w-0 max-w-3xl">
        <div
          className="new-session-project-card absolute inset-x-3 bottom-[calc(100%-10px)] z-0 flex h-[calc(2.25rem+10px)] items-center rounded-t-xl border border-border/80 bg-muted/95 px-2.5 pb-2.5 shadow-[0_-3px_12px_rgb(0_0_0/0.035)]"
          data-visible={isNewSession ? "true" : "false"}
          aria-hidden={!isNewSession}
        >
          {isNewSession ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <ProjectPicker
                project={project}
                projects={projects}
                placement="card"
                onChange={onProjectChange}
                onCreateProject={onCreateProject}
              />
              {project ? (
                <SessionLocationPicker
                  session={session}
                  onChange={onExecutionModeChange}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <Card className="relative z-10 w-full min-w-0 gap-0 overflow-hidden rounded-xl py-0 shadow-[0_8px_28px_rgb(0_0_0/0.07),0_1px_2px_rgb(0_0_0/0.08)] ring-foreground/10">
          {approval && activeRunId ? (
            <ApprovalPrompt
              approval={approval}
              onRespond={(decision) =>
                onApproval(activeRunId, approval.id, decision)
              }
            />
          ) : (
            <>
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={preparingSession}
                placeholder="Do anything"
                rows={2}
                className="block max-h-32 min-h-[3.375rem] min-w-0 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3.5 pt-2.5 pb-1 text-[14px] leading-5 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
              />
              {preparationError ? (
                <div className="flex items-start gap-1.5 px-3.5 pb-1.5 text-[11px] leading-4 text-destructive">
                  <AlertCircle
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{preparationError}</span>
                </div>
              ) : null}
              <CardFooter className="min-h-10 justify-between gap-2 rounded-b-xl border-0 bg-card px-2.5 py-1.5">
                <AccessModePicker
                  provider={provider ?? "gemini"}
                  mode={accessMode}
                  onChange={onAccessModeChange}
                />
                <div className="ml-auto flex min-w-0 items-center gap-1">
                  {hasAgentSession ? (
                    <ContextUsageIndicator
                      usage={usage}
                      contextWindow={contextWindow}
                    />
                  ) : null}
                  <ModelPicker
                    provider={provider}
                    model={model}
                    reasoningEffort={session.reasoningEffort}
                    speed={session.speed}
                    models={models}
                    loading={modelsLoading}
                    onChange={onModelChange}
                  />
                  {isRunning && activeRunId ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="secondary"
                      className="size-7 rounded-full"
                      aria-label={
                        isEscapeStopArmed
                          ? "Press Escape again to stop response"
                          : "Stop response"
                      }
                      onClick={() => onCancel(activeRunId)}
                    >
                      {isEscapeStopArmed ? (
                        <span className="text-[9px] leading-none font-semibold tracking-[-0.03em]">
                          ESC
                        </span>
                      ) : (
                        <Square
                          className="size-3 fill-current"
                          aria-hidden="true"
                        />
                      )}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="icon-sm"
                      className="size-7 rounded-full shadow-sm"
                      disabled={
                        !draft.trim() || isSubmitting || preparingSession
                      }
                      aria-label={
                        preparingSession ? "Creating worktree" : "Send message"
                      }
                      onClick={() => void submit()}
                    >
                      {isSubmitting || preparingSession ? (
                        <LoaderCircle
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      )}
                    </Button>
                  )}
                </div>
              </CardFooter>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function SessionView({
  project,
  session,
  availableModels,
  modelsLoading,
  accessMode,
  projects,
  onProjectChange,
  onCreateProject,
  onModelChange,
  onAccessModeChange,
  onExecutionModeChange,
  onSend,
  onCancel,
  onApproval,
  preparingSession,
  preparationError,
}: {
  project: Project | null;
  session: ChatSession;
  availableModels: AgentModel[];
  modelsLoading: boolean;
  accessMode: AgentAccessMode;
  projects: Project[];
  onProjectChange: (projectId: string | null) => void;
  onCreateProject: () => void;
  onModelChange: (selection: AgentModelSelection) => void;
  onAccessModeChange: (mode: AgentAccessMode) => void;
  onExecutionModeChange: ChatWorkspaceProps["onExecutionModeChange"];
  onSend: ChatWorkspaceProps["onSend"];
  onCancel: (runId: string) => void;
  onApproval: ChatWorkspaceProps["onApproval"];
  preparingSession: boolean;
  preparationError?: string;
}) {
  const activeMessage = [...session.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        (message.status === "thinking" || message.status === "streaming"),
    );
  const contextWindow = availableModels.find(
    (availableModel) =>
      availableModel.provider === (session.provider ?? "gemini") &&
      availableModel.model === session.model,
  )?.contextWindow;

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
      <MessageScrollerProvider
        autoScroll
        defaultScrollPosition="end"
        scrollPreviousItemPeek={48}
      >
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-7 px-5 pt-9 pb-8 sm:px-8 sm:pt-12">
              {session.messages.length === 0 ? (
                <NewSessionPrompt
                  project={project}
                  projects={projects}
                  onProjectChange={onProjectChange}
                  onCreateProject={onCreateProject}
                />
              ) : null}

              {session.messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                >
                  {message.role === "user" ? (
                    <UserMessage message={message} />
                  ) : (
                    <AgentResponse message={message} />
                  )}
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton className="bottom-3 shadow-md" />
        </MessageScroller>
      </MessageScrollerProvider>

      <Composer
        isRunning={Boolean(activeMessage)}
        activeRunId={activeMessage?.runId}
        approval={activeMessage?.approval}
        provider={session.provider}
        model={session.model}
        usage={session.usage}
        contextWindow={contextWindow}
        hasAgentSession={Boolean(session.conversationId)}
        models={availableModels}
        modelsLoading={modelsLoading}
        accessMode={accessMode}
        session={session}
        project={project}
        projects={projects}
        isNewSession={session.messages.length === 0}
        preparingSession={preparingSession}
        preparationError={preparationError}
        onProjectChange={onProjectChange}
        onCreateProject={onCreateProject}
        onModelChange={onModelChange}
        onAccessModeChange={onAccessModeChange}
        onExecutionModeChange={onExecutionModeChange}
        onSend={onSend}
        onCancel={onCancel}
        onApproval={onApproval}
      />
    </div>
  );
}

export function ChatWorkspace({
  projects,
  project,
  session,
  availableModels,
  modelsLoading,
  accessMode,
  onCreateProject,
  onCreateSession,
  onProjectChange,
  onModelChange,
  onAccessModeChange,
  onExecutionModeChange,
  onSend,
  onCancel,
  onApproval,
  terminalOpen,
  onTerminalOpenChange,
  preparingSession,
  preparationError,
}: ChatWorkspaceProps) {
  return (
    <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
      <WorkspaceHeader
        project={project}
        session={session}
        terminalOpen={terminalOpen}
        onTerminalOpenChange={onTerminalOpenChange}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!session ? (
          <EmptyState
            icon={<Plus className="size-4" aria-hidden="true" />}
            title={
              project ? `Start a session in ${project.name}` : "Start a chat"
            }
            description={
              project
                ? undefined
                : "Work without connecting this conversation to a project."
            }
            action={
              <Button onClick={() => onCreateSession(project?.id ?? null)}>
                <Plus aria-hidden="true" />
                New chat
              </Button>
            }
          />
        ) : (
          <SessionView
            key={session.id}
            project={project}
            session={session}
            availableModels={availableModels}
            modelsLoading={modelsLoading}
            accessMode={accessMode}
            projects={projects}
            onProjectChange={onProjectChange}
            onCreateProject={onCreateProject}
            onModelChange={onModelChange}
            onAccessModeChange={onAccessModeChange}
            onExecutionModeChange={onExecutionModeChange}
            onSend={onSend}
            onCancel={onCancel}
            onApproval={onApproval}
            preparingSession={preparingSession}
            preparationError={preparationError}
          />
        )}
      </div>
      <TerminalPanel
        project={project}
        session={session}
        open={terminalOpen}
        onClose={() => onTerminalOpenChange(false)}
      />
    </SidebarInset>
  );
}
