import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import * as pty from "node-pty";

import type {
  GeminiAccountUsage,
  GeminiQuotaSnapshot,
  GeminiTokenTotals,
} from "./types";

type JsonRecord = Record<string, unknown>;

type GeminiUsageCapture = {
  output: string;
  timedOut: boolean;
};

const MAX_CAPTURE_LENGTH = 250_000;
const MAX_SESSION_FILES = 2_000;
const GEMINI_USAGE_TIMEOUT_MS = 25_000;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function finiteTokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function stripTerminalFormatting(value: string) {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI terminal output contains escape and bell control codes.
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI terminal output contains escape control codes.
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI terminal output contains escape control codes.
      .replace(/\u001b[@-_]/g, "")
      .replace(/\r/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remaining terminal control codes must not reach the parser.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

function cleanCapturedLabel(value: string) {
  return value
    .replace(/[▄▀▬⣷⣯⣟⡿⢿⣻⣽⣾]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastMatch(value: string, pattern: RegExp) {
  let result: RegExpExecArray | null = null;
  for (const match of value.matchAll(pattern)) {
    result = match;
  }
  return result;
}

export function dailyRequestLimitForTier(tier: string | undefined) {
  const normalized = tier?.toLowerCase() ?? "";
  if (normalized.includes("ultra") || normalized.includes("enterprise")) {
    return 2_000;
  }
  if (
    normalized.includes("pro") ||
    normalized.includes("standard") ||
    normalized.includes("developer program")
  ) {
    return 1_500;
  }
  if (normalized.includes("individual") || normalized.includes("free")) {
    return 1_000;
  }
  return undefined;
}

export function parseGeminiQuotaOutput(output: string): GeminiQuotaSnapshot {
  const text = stripTerminalFormatting(output);
  const tierMatch = lastMatch(text, /\bTier:\s*([^\n]{1,100})/gi);
  const authMatch = lastMatch(text, /\bAuth Method:\s*([^\n]{1,100})/gi);
  const tier = cleanCapturedLabel(tierMatch?.[1] ?? "") || undefined;
  const authMethod = cleanCapturedLabel(authMatch?.[1] ?? "") || undefined;

  const modelsByName = new Map<string, GeminiQuotaSnapshot["models"][number]>();
  const modelPattern =
    /\b(Pro|Flash Lite|Flash)\b[^\n%]{0,180}?(\d{1,3})%(?:[^\n]*?Resets:\s*([^\n]{1,80}))?[^\n]*/gi;
  for (const match of text.matchAll(modelPattern)) {
    const usedPercent = Math.min(100, Math.max(0, Number(match[2])));
    const resetLabel = cleanCapturedLabel(match[3] ?? "") || undefined;
    modelsByName.set(match[1], {
      name: match[1],
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetLabel,
    });
  }

  const usedMatch = lastMatch(
    text,
    /(\d{1,3})% used(?:\s*\(Limit resets in\s*([^)]+)\))?/gi,
  );
  const limitMatch = lastMatch(text, /Usage limit:\s*([\d,]+)/gi);
  const usedPercent = usedMatch
    ? Math.min(100, Math.max(0, Number(usedMatch[1])))
    : undefined;
  const reportedLimit = limitMatch
    ? Number(limitMatch[1].replace(/,/g, ""))
    : undefined;
  const limit =
    reportedLimit && Number.isFinite(reportedLimit) && reportedLimit > 0
      ? reportedLimit
      : dailyRequestLimitForTier(tier);
  const used =
    limit !== undefined && usedPercent !== undefined
      ? Math.round((limit * usedPercent) / 100)
      : undefined;

  return {
    period: "daily",
    tier,
    authMethod,
    limit,
    used,
    remaining:
      limit !== undefined && used !== undefined ? limit - used : undefined,
    usedPercent,
    resetLabel:
      cleanCapturedLabel(usedMatch?.[2] ?? "") ||
      [...modelsByName.values()].find((model) => model.resetLabel)?.resetLabel,
    models: [...modelsByName.values()],
  };
}

function terminalEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function captureGeminiUsage(
  executable: string,
  cwd: string,
): Promise<GeminiUsageCapture> {
  return new Promise((resolve) => {
    let output = "";
    let stage: "about" | "stats" | "model" | "done" = "about";
    let settled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let terminalProcess: pty.IPty;
    let dataDisposable: { dispose: () => void } | undefined;
    let exitDisposable: { dispose: () => void } | undefined;

    const schedule = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
    };

    const finish = (timedOut: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      try {
        terminalProcess.kill();
      } catch {
        // The CLI may already have exited after /quit.
      }
      dataDisposable?.dispose();
      exitDisposable?.dispose();
      resolve({ output, timedOut });
    };

    try {
      terminalProcess = pty.spawn(
        executable,
        [
          "--screen-reader",
          "--skip-trust",
          "--model",
          "auto",
          "--prompt-interactive",
          "/about",
        ],
        {
          name: "xterm-256color",
          cols: 120,
          rows: 42,
          cwd,
          env: {
            ...terminalEnvironment(),
            NO_BROWSER: "true",
            NO_COLOR: "1",
          },
        },
      );
    } catch (error) {
      resolve({
        output: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    const timeout = setTimeout(() => finish(true), GEMINI_USAGE_TIMEOUT_MS);
    timers.add(timeout);

    dataDisposable = terminalProcess.onData((chunk) => {
      output = `${output}${chunk}`.slice(-MAX_CAPTURE_LENGTH);
      const text = stripTerminalFormatting(output);

      if (
        /Authentication consent could not be obtained|Error authenticating|Please run Gemini CLI in an interactive terminal|Please visit the following URL to authorize|Enter the authorization code/i.test(
          text,
        )
      ) {
        schedule(() => finish(false), 100);
        return;
      }

      if (
        stage === "about" &&
        /About Gemini CLI|CLI Version:|Auth Method:|Session ID:/i.test(text)
      ) {
        stage = "stats";
        schedule(() => terminalProcess.write("/stats\r"), 250);
        return;
      }

      if (stage === "stats" && /Session Stats/i.test(text)) {
        stage = "model";
        schedule(() => terminalProcess.write("/model\r"), 350);
        return;
      }

      if (
        stage === "model" &&
        (/Model usage/i.test(text) ||
          (/Select Model/i.test(text) && /Press Esc to close/i.test(text)))
      ) {
        stage = "done";
        schedule(() => terminalProcess.write("\u001b"), 500);
        schedule(() => terminalProcess.write("/quit\r"), 750);
        schedule(() => finish(false), 1_500);
      }
    });

    exitDisposable = terminalProcess.onExit(() => finish(false));
  });
}

async function listGeminiSessionFiles(root: string) {
  const files: string[] = [];
  const directories: Array<{
    directory: string;
    depth: number;
    inChats: boolean;
  }> = [{ directory: root, depth: 0, inChats: false }];

  while (directories.length > 0 && files.length < MAX_SESSION_FILES) {
    const current = directories.pop();
    if (!current || current.depth > 6) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.directory, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        directories.push({
          directory: entryPath,
          depth: current.depth + 1,
          inChats: current.inChats || entry.name === "chats",
        });
      } else if (
        entry.isFile() &&
        current.inChats &&
        entry.name.endsWith(".jsonl")
      ) {
        files.push(entryPath);
        if (files.length >= MAX_SESSION_FILES) {
          break;
        }
      }
    }
  }

  return files;
}

function addMessage(
  messages: Map<string, JsonRecord>,
  order: string[],
  value: unknown,
) {
  const message = asRecord(value);
  if (!message || typeof message.id !== "string") {
    return;
  }
  if (!messages.has(message.id)) {
    order.push(message.id);
  }
  messages.set(message.id, message);
}

async function readSessionTokenTotals(filePath: string, periodStart: number) {
  const messages = new Map<string, JsonRecord>();
  const order: string[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(value);
      if (!record) {
        continue;
      }
      const setRecord = asRecord(record.$set);
      if (Array.isArray(setRecord?.messages)) {
        messages.clear();
        order.length = 0;
        for (const message of setRecord.messages) {
          addMessage(messages, order, message);
        }
        continue;
      }
      if (typeof record.$rewindTo === "string") {
        const rewindIndex = order.indexOf(record.$rewindTo);
        if (rewindIndex >= 0) {
          for (const id of order.splice(rewindIndex)) {
            messages.delete(id);
          }
        }
        continue;
      }
      addMessage(messages, order, record);
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  const totals = {
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    thoughts: 0,
    tool: 0,
    modelCalls: 0,
  };
  for (const message of messages.values()) {
    if (message.type !== "gemini" || typeof message.timestamp !== "string") {
      continue;
    }
    const timestamp = Date.parse(message.timestamp);
    const tokens = asRecord(message.tokens);
    if (!tokens || !Number.isFinite(timestamp) || timestamp < periodStart) {
      continue;
    }
    totals.total += finiteTokenCount(tokens.total);
    totals.input += finiteTokenCount(tokens.input);
    totals.output += finiteTokenCount(tokens.output);
    totals.cached += finiteTokenCount(tokens.cached);
    totals.thoughts += finiteTokenCount(tokens.thoughts);
    totals.tool += finiteTokenCount(tokens.tool);
    totals.modelCalls += 1;
  }
  return totals;
}

async function readGeminiTokenTotals(homeDirectory: string) {
  const periodStartDate = new Date();
  periodStartDate.setHours(0, 0, 0, 0);
  const periodStart = periodStartDate.getTime();
  const totals: GeminiTokenTotals = {
    periodStart: periodStartDate.toISOString(),
    periodEnd: new Date().toISOString(),
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    thoughts: 0,
    tool: 0,
    modelCalls: 0,
    sessions: 0,
  };
  const files = await listGeminiSessionFiles(
    path.join(homeDirectory, ".gemini", "tmp"),
  );

  for (const filePath of files) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.mtimeMs < periodStart) {
        continue;
      }
      const sessionTotals = await readSessionTokenTotals(filePath, periodStart);
      if (sessionTotals.modelCalls > 0) {
        totals.sessions += 1;
      }
      totals.total += sessionTotals.total;
      totals.input += sessionTotals.input;
      totals.output += sessionTotals.output;
      totals.cached += sessionTotals.cached;
      totals.thoughts += sessionTotals.thoughts;
      totals.tool += sessionTotals.tool;
      totals.modelCalls += sessionTotals.modelCalls;
    } catch {
      // A session may be rotated while usage is being read.
    }
  }

  return totals;
}

function quotaErrorForCapture(capture: GeminiUsageCapture) {
  const text = stripTerminalFormatting(capture.output);
  if (
    /Authentication consent could not be obtained|Error authenticating|not authenticated|sign in to|finish signing in|Please visit the following URL to authorize|Enter the authorization code/i.test(
      text,
    )
  ) {
    return "Gemini CLI is not signed in. Conductor will retry automatically.";
  }
  if (capture.timedOut) {
    return "Gemini CLI did not return quota data. Conductor will retry automatically.";
  }
  return "Gemini CLI did not expose account quota for the current authentication method.";
}

export async function getGeminiAccountUsage(
  executable: string,
  homeDirectory: string,
): Promise<GeminiAccountUsage> {
  const [tokens, capture] = await Promise.all([
    readGeminiTokenTotals(homeDirectory),
    captureGeminiUsage(executable, homeDirectory),
  ]);
  const quota = parseGeminiQuotaOutput(capture.output);
  const hasQuota =
    quota.limit !== undefined ||
    quota.usedPercent !== undefined ||
    quota.models.length > 0;

  return {
    provider: "gemini",
    measuredAt: new Date().toISOString(),
    tokens,
    quota,
    quotaError: hasQuota ? undefined : quotaErrorForCapture(capture),
  };
}
