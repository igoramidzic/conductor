import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  type Project,
  STANDALONE_TERMINAL_GROUP_ID,
  type TerminalEvent,
  type TerminalTab,
} from "@/types";

type TerminalPanelProps = {
  project: Project | null;
  open: boolean;
  onClose: () => void;
};

function readColor(element: HTMLElement, property: string) {
  return getComputedStyle(element).getPropertyValue(property).trim();
}

function getTerminalTheme(element: HTMLElement): ITheme {
  return {
    background: "#00000000",
    foreground: readColor(element, "--foreground"),
    cursor: readColor(element, "--primary"),
    cursorAccent: "#00000000",
    selectionBackground: readColor(element, "--terminal-selection"),
    black: readColor(element, "--terminal-black"),
    red: readColor(element, "--terminal-red"),
    green: readColor(element, "--terminal-green"),
    yellow: readColor(element, "--terminal-yellow"),
    blue: readColor(element, "--terminal-blue"),
    magenta: readColor(element, "--terminal-magenta"),
    cyan: readColor(element, "--terminal-cyan"),
    white: readColor(element, "--terminal-white"),
    brightBlack: readColor(element, "--terminal-bright-black"),
    brightRed: readColor(element, "--terminal-bright-red"),
    brightGreen: readColor(element, "--terminal-bright-green"),
    brightYellow: readColor(element, "--terminal-bright-yellow"),
    brightBlue: readColor(element, "--terminal-bright-blue"),
    brightMagenta: readColor(element, "--terminal-bright-magenta"),
    brightCyan: readColor(element, "--terminal-bright-cyan"),
    brightWhite: readColor(element, "--terminal-bright-white"),
  };
}

function TerminalViewport({
  projectId,
  tab,
  active,
  panelOpen,
}: {
  projectId: string;
  tab: TerminalTab;
  active: boolean;
  panelOpen: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new XTerm({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        '"SFMono-Regular", "Cascadia Code", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.25,
      macOptionIsMeta: true,
      scrollback: 10_000,
      theme: getTerminalTheme(host),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const updateTheme = () => {
      terminal.options.theme = getTerminalTheme(host);
    };
    updateTheme();
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.metaKey) {
        return true;
      }
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        void navigator.clipboard
          .writeText(terminal.getSelection())
          .catch(() => undefined);
        return false;
      }
      if (key === "v") {
        void navigator.clipboard
          .readText()
          .then((text) => terminal.paste(text))
          .catch(() => undefined);
        return false;
      }
      return true;
    });

    const inputSubscription = terminal.onData((data) => {
      window.electron.writeTerminal({
        projectId,
        terminalId: tab.id,
        data,
      });
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      window.electron.resizeTerminal({
        projectId,
        terminalId: tab.id,
        cols,
        rows,
      });
    });

    let initialized = false;
    let lastSequence = 0;
    const pendingEvents: Extract<TerminalEvent, { type: "data" }>[] = [];
    const writeEvent = (event: Extract<TerminalEvent, { type: "data" }>) => {
      if (event.sequence <= lastSequence) {
        return;
      }
      lastSequence = event.sequence;
      terminal.write(event.data);
    };
    const unsubscribe = window.electron.onTerminalEvent((event) => {
      if (
        event.type !== "data" ||
        event.projectId !== projectId ||
        event.terminalId !== tab.id
      ) {
        return;
      }
      if (!initialized) {
        pendingEvents.push(event);
        return;
      }
      writeEvent(event);
    });

    const finishInitialization = () => {
      initialized = true;
      for (const event of pendingEvents) {
        writeEvent(event);
      }
      pendingEvents.length = 0;
      try {
        fitAddon.fit();
      } catch {
        // The panel can be midway through its zero-height close transition.
      }
    };

    void window.electron
      .readTerminal({ projectId, terminalId: tab.id })
      .then((snapshot) => {
        lastSequence = snapshot.sequence;
        if (snapshot.output) {
          terminal.write(snapshot.output, finishInitialization);
        } else {
          finishInitialization();
        }
      })
      .catch(() => {
        terminal.writeln(
          "\r\n\x1b[31mTerminal session is no longer available.\x1b[0m",
        );
        finishInitialization();
      });

    let fitFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          // Ignore transient zero-size frames during panel motion.
        }
      });
    });
    observer.observe(host);

    return () => {
      cancelAnimationFrame(fitFrame);
      observer.disconnect();
      themeObserver.disconnect();
      unsubscribe();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [projectId, tab.id]);

  useEffect(() => {
    if (!active || !panelOpen) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // The panel may still be entering its first measurable frame.
      }
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, panelOpen]);

  return (
    <div
      className={cn(
        "absolute inset-0 px-3 py-2 transition-opacity duration-150 motion-reduce:transition-none",
        active
          ? "visible opacity-100"
          : "pointer-events-none invisible opacity-0",
      )}
      aria-hidden={!active}
    >
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}

export function TerminalPanel({ project, open, onClose }: TerminalPanelProps) {
  const projectId = project?.id ?? STANDALONE_TERMINAL_GROUP_ID;
  const sourceFolder = project?.sourceFolder;
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingProjectRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const activeTabsByProjectRef = useRef(new Map<string, string>());

  useEffect(() => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setTabs([]);
    setActiveTabId(null);
    setLoadedProjectId(null);
    setError(null);
    creatingProjectRef.current = null;

    void window.electron
      .listTerminals(projectId)
      .then((nextTabs) => {
        if (generation !== loadGenerationRef.current) {
          return;
        }
        const rememberedId = activeTabsByProjectRef.current.get(projectId);
        const nextActiveId = nextTabs.some((tab) => tab.id === rememberedId)
          ? (rememberedId ?? null)
          : (nextTabs[0]?.id ?? null);
        setTabs(nextTabs);
        setActiveTabId(nextActiveId);
        setLoadedProjectId(projectId);
      })
      .catch((reason: unknown) => {
        if (generation !== loadGenerationRef.current) {
          return;
        }
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load terminals.",
        );
        setLoadedProjectId(projectId);
      });
  }, [projectId]);

  useEffect(() => {
    return window.electron.onTerminalEvent((event) => {
      if (event.type !== "exit" || event.projectId !== projectId) {
        return;
      }
      setTabs((current) =>
        current.map((tab) =>
          tab.id === event.terminalId
            ? {
                ...tab,
                status: "exited",
                exitCode: event.exitCode,
              }
            : tab,
        ),
      );
    });
  }, [projectId]);

  const createTerminal = useCallback(() => {
    if (creatingProjectRef.current === projectId) {
      return;
    }
    creatingProjectRef.current = projectId;
    const generation = loadGenerationRef.current;
    setError(null);
    void window.electron
      .createTerminal({
        projectId,
        sourceFolder,
        cols: 100,
        rows: 24,
      })
      .then((tab) => {
        if (generation !== loadGenerationRef.current) {
          return;
        }
        setTabs((current) =>
          current.some((item) => item.id === tab.id)
            ? current
            : [...current, tab],
        );
        activeTabsByProjectRef.current.set(projectId, tab.id);
        setActiveTabId(tab.id);
      })
      .catch((reason: unknown) => {
        if (generation !== loadGenerationRef.current) {
          return;
        }
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not start a terminal.",
        );
      })
      .finally(() => {
        if (creatingProjectRef.current === projectId) {
          creatingProjectRef.current = null;
        }
      });
  }, [projectId, sourceFolder]);

  useEffect(() => {
    if (
      open &&
      projectId &&
      loadedProjectId === projectId &&
      tabs.length === 0 &&
      !error
    ) {
      createTerminal();
    }
  }, [createTerminal, error, loadedProjectId, open, projectId, tabs.length]);

  function selectTab(terminalId: string) {
    activeTabsByProjectRef.current.set(projectId, terminalId);
    setActiveTabId(terminalId);
  }

  function closeTab(terminalId: string) {
    void window.electron.closeTerminal({
      projectId,
      terminalId,
    });
    const index = tabs.findIndex((tab) => tab.id === terminalId);
    const nextTabs = tabs.filter((tab) => tab.id !== terminalId);
    setTabs(nextTabs);
    if (activeTabId === terminalId) {
      const nextActive =
        nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)]?.id ?? null;
      if (nextActive) {
        activeTabsByProjectRef.current.set(projectId, nextActive);
      } else {
        activeTabsByProjectRef.current.delete(projectId);
        onClose();
      }
      setActiveTabId(nextActive);
    }
  }

  const isVisible = open;
  const displayedTabs = loadedProjectId === projectId ? tabs : [];
  const shortcut = window.electron.platform === "darwin" ? "⌘J" : "Ctrl+J";

  return (
    <section
      className="terminal-panel app-no-drag relative shrink-0 overflow-hidden bg-background text-foreground"
      data-open={isVisible}
      aria-label={project ? `${project.name} terminal` : "Standalone terminal"}
      aria-hidden={!isVisible}
    >
      <div className="terminal-panel-inner flex h-full min-h-0 flex-col border-t border-border">
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-background">
          <div
            className="terminal-tab-strip flex min-w-0 flex-1 items-stretch overflow-x-auto"
            role="tablist"
            aria-label="Terminal tabs"
          >
            {displayedTabs.map((tab) => {
              const active = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group/tab relative flex h-9 max-w-48 min-w-28 shrink-0 items-center border-r border-border/70 text-[11px] transition-colors",
                    active
                      ? "bg-muted text-foreground"
                      : "bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => selectTab(tab.id)}
                  >
                    <SquareTerminal
                      className="size-3.5 shrink-0 opacity-70"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                    {tab.status === "exited" ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-destructive"
                        title={`Exited with code ${tab.exitCode ?? "unknown"}`}
                      />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    className={cn(
                      "mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                      active
                        ? "opacity-80"
                        : "opacity-0 group-hover/tab:opacity-70",
                    )}
                    onClick={() => closeTab(tab.id)}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="flex size-9 shrink-0 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
              aria-label="New terminal tab"
              title="New terminal"
              onClick={createTerminal}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex shrink-0 items-center px-1.5">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Close terminal panel"
              title={`Close terminal (${shortcut})`}
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 bg-background">
          {error ? (
            <div className="flex h-full items-center justify-center px-6 text-center font-mono text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {!error && loadedProjectId === projectId && tabs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <SquareTerminal
                className="size-5 opacity-60"
                aria-hidden="true"
              />
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-foreground outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
                onClick={createTerminal}
              >
                New terminal
              </button>
            </div>
          ) : null}
          {displayedTabs.map((tab) => (
            <TerminalViewport
              key={tab.id}
              projectId={projectId}
              tab={tab}
              active={tab.id === activeTabId}
              panelOpen={isVisible}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
