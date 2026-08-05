import {
  AlertCircle,
  ArrowUp,
  Check,
  FilePenLine,
  Folder,
  ListChecks,
  Plus,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import {
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
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  AgentAccessMode,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentModel,
  AgentProvider,
  ChatMessage,
  ChatSession,
  Project,
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
  onModelChange: (model: AgentModel) => void;
  onAccessModeChange: (mode: AgentAccessMode) => void;
  onSend: (prompt: string) => void;
  onCancel: (runId: string) => void;
  onApproval: (
    runId: string,
    approvalId: string,
    decision: AgentApprovalDecision,
  ) => void;
  terminalOpen: boolean;
  onTerminalOpenChange: (open: boolean) => void;
};

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
          {project ? (
            <p className="mt-1 truncate font-mono text-[9px] leading-none text-muted-foreground/70">
              {project.sourceFolder}
            </p>
          ) : null}
        </div>
      </div>
      <div className="app-no-drag relative z-10 flex shrink-0 items-center pr-2.5">
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

function AgentResponse({ message }: { message: ChatMessage }) {
  const activities = message.activities ?? [];
  const hasRunningActivity = activities.some(
    (activity) => activity.status === "running",
  );
  const showThinking = message.status === "thinking" && !hasRunningActivity;
  const animatedChunks = useMemo(
    () => splitResponseChunks(message.chunks),
    [message.chunks],
  );

  return (
    <Message>
      <MessageContent className="gap-2.5">
        {activities.map((activity) => (
          <Marker key={activity.id} role="status" className="w-fit text-xs">
            <MarkerIcon>
              {activity.status === "running" ? (
                <ThinkingDots />
              ) : (
                <Check className="size-3.5" />
              )}
            </MarkerIcon>
            <MarkerContent
              className={activity.status === "running" ? "shimmer" : undefined}
            >
              {activity.label}
              {activity.status === "running" ? "…" : ""}
            </MarkerContent>
          </Marker>
        ))}

        {showThinking ? (
          <Marker role="status" className="w-fit text-xs">
            <MarkerIcon>
              <ThinkingDots />
            </MarkerIcon>
            <MarkerContent className="shimmer">Thinking…</MarkerContent>
          </Marker>
        ) : null}

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

function ModelPicker({
  provider,
  model,
  models,
  loading,
  onChange,
}: {
  provider?: AgentProvider;
  model?: string;
  models: AgentModel[];
  loading: boolean;
  onChange: (model: AgentModel) => void;
}) {
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

  return (
    <Combobox
      items={groups}
      value={selectedModel}
      onValueChange={(nextModel: AgentModel | null) => {
        if (nextModel) {
          onChange(nextModel);
        }
      }}
      itemToStringLabel={(item: AgentModel) =>
        `${item.group} ${item.label} ${item.model}`
      }
      itemToStringValue={(item: AgentModel) =>
        `${item.group} ${item.label} ${item.model}`
      }
      isItemEqualToValue={(item, value) =>
        item.provider === value?.provider && item.model === value.model
      }
    >
      <ComboboxTrigger
        render={<Button type="button" variant="ghost" size="sm" />}
        aria-label="Model"
        aria-busy={loading}
        className="h-7 min-w-0 max-w-64 justify-start gap-1.5 px-2 text-[11px] text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <ComboboxValue>
            {() =>
              loading && !selectedModel
                ? "Finding models…"
                : selectedModel
                  ? `${selectedModel.group} · ${selectedModel.label}`
                  : "No models"
            }
          </ComboboxValue>
        </span>
      </ComboboxTrigger>

      <ComboboxContent side="top" className="w-80 min-w-80">
        <ComboboxInput
          placeholder="Search models…"
          aria-label="Search models"
          showTrigger={false}
          showClear
        />
        <ComboboxEmpty>No models found.</ComboboxEmpty>
        <ComboboxList>
          {(group: AgentModelGroup) => (
            <ComboboxGroup
              key={group.value}
              items={group.items}
              className="pb-1 last:pb-0"
            >
              <ComboboxLabel className="px-2 pt-2 pb-1 text-[9px] font-semibold tracking-[0.1em] uppercase">
                {group.value}
              </ComboboxLabel>
              <ComboboxCollection>
                {(availableModel: AgentModel) => (
                  <ComboboxItem
                    key={`${availableModel.provider}:${availableModel.model}`}
                    value={availableModel}
                    className="min-h-8 px-2 py-1.5 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {availableModel.label}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
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
      <div className="group/project-picker relative inline-flex min-w-0 max-w-[70%]">
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

function Composer({
  isRunning,
  activeRunId,
  approval,
  provider,
  model,
  models,
  modelsLoading,
  accessMode,
  project,
  projects,
  isNewSession,
  onProjectChange,
  onCreateProject,
  onModelChange,
  onAccessModeChange,
  onSend,
  onCancel,
  onApproval,
}: {
  isRunning: boolean;
  activeRunId?: string;
  approval?: AgentApprovalRequest;
  provider?: AgentProvider;
  model?: string;
  models: AgentModel[];
  modelsLoading: boolean;
  accessMode: AgentAccessMode;
  project: Project | null;
  projects: Project[];
  isNewSession: boolean;
  onProjectChange: (projectId: string | null) => void;
  onCreateProject: () => void;
  onModelChange: (model: AgentModel) => void;
  onAccessModeChange: (mode: AgentAccessMode) => void;
  onSend: (prompt: string) => void;
  onCancel: (runId: string) => void;
  onApproval: ChatWorkspaceProps["onApproval"];
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  function submit() {
    const prompt = draft.trim();
    if (!prompt || isRunning) {
      return;
    }
    setDraft("");
    onSend(prompt);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
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
            <ProjectPicker
              project={project}
              projects={projects}
              placement="card"
              onChange={onProjectChange}
              onCreateProject={onCreateProject}
            />
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
                placeholder="Do anything"
                rows={1}
                className="block max-h-32 min-h-9 min-w-0 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3.5 pt-2.5 pb-1 text-[14px] leading-5 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
              />
              <CardFooter className="min-h-10 justify-between gap-2 rounded-b-xl border-0 bg-card px-2.5 py-1.5">
                <AccessModePicker
                  provider={provider ?? "gemini"}
                  mode={accessMode}
                  onChange={onAccessModeChange}
                />
                <div className="ml-auto flex min-w-0 items-center gap-1">
                  <ModelPicker
                    provider={provider}
                    model={model}
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
                      aria-label="Stop response"
                      onClick={() => onCancel(activeRunId)}
                    >
                      <Square
                        className="size-3 fill-current"
                        aria-hidden="true"
                      />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="icon-sm"
                      className="size-7 rounded-full shadow-sm"
                      disabled={!draft.trim()}
                      aria-label="Send message"
                      onClick={submit}
                    >
                      <ArrowUp aria-hidden="true" />
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
  onSend,
  onCancel,
  onApproval,
}: {
  project: Project | null;
  session: ChatSession;
  availableModels: AgentModel[];
  modelsLoading: boolean;
  accessMode: AgentAccessMode;
  projects: Project[];
  onProjectChange: (projectId: string | null) => void;
  onCreateProject: () => void;
  onModelChange: (model: AgentModel) => void;
  onAccessModeChange: (mode: AgentAccessMode) => void;
  onSend: (prompt: string) => void;
  onCancel: (runId: string) => void;
  onApproval: ChatWorkspaceProps["onApproval"];
}) {
  const activeMessage = [...session.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        (message.status === "thinking" || message.status === "streaming"),
    );

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
        models={availableModels}
        modelsLoading={modelsLoading}
        accessMode={accessMode}
        project={project}
        projects={projects}
        isNewSession={session.messages.length === 0}
        onProjectChange={onProjectChange}
        onCreateProject={onCreateProject}
        onModelChange={onModelChange}
        onAccessModeChange={onAccessModeChange}
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
  onSend,
  onCancel,
  onApproval,
  terminalOpen,
  onTerminalOpenChange,
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
            onSend={onSend}
            onCancel={onCancel}
            onApproval={onApproval}
          />
        )}
      </div>
      <TerminalPanel
        project={project}
        open={terminalOpen}
        onClose={() => onTerminalOpenChange(false)}
      />
    </SidebarInset>
  );
}
