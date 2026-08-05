import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AgentUsage } from "./types";

type JsonRecord = Record<string, unknown>;

type GeminiConversation = {
  sessionId?: string;
  messages: JsonRecord[];
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as JsonRecord)
    : undefined;
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

function readGeminiConversation(
  filePath: string,
): GeminiConversation | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }

  if (filePath.endsWith(".json")) {
    try {
      const conversation = asRecord(JSON.parse(contents));
      const messages = Array.isArray(conversation?.messages)
        ? conversation.messages.flatMap((message) => {
            const record = asRecord(message);
            return record ? [record] : [];
          })
        : [];
      const sessionId =
        typeof conversation?.sessionId === "string"
          ? conversation.sessionId
          : typeof conversation?.session_id === "string"
            ? conversation.session_id
            : undefined;
      return { sessionId, messages };
    } catch {
      return undefined;
    }
  }

  let sessionId: string | undefined;
  const messages = new Map<string, JsonRecord>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record: JsonRecord | undefined;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record) {
      continue;
    }

    if (typeof record.sessionId === "string") {
      sessionId = record.sessionId;
    } else if (typeof record.session_id === "string") {
      sessionId = record.session_id;
    }

    const updates = asRecord(record.$set);
    if (typeof updates?.sessionId === "string") {
      sessionId = updates.sessionId;
    }
    if (Array.isArray(updates?.messages)) {
      messages.clear();
      for (const message of updates.messages) {
        const value = asRecord(message);
        if (value && typeof value.id === "string") {
          messages.set(value.id, value);
        }
      }
    }

    if (typeof record.$rewindTo === "string") {
      let remove = false;
      for (const id of messages.keys()) {
        if (id === record.$rewindTo) {
          remove = true;
        }
        if (remove) {
          messages.delete(id);
        }
      }
    } else if (typeof record.id === "string") {
      messages.set(record.id, record);
    }
  }

  return { sessionId, messages: [...messages.values()] };
}

function geminiMessageUsage(
  message: JsonRecord,
  contextWindow: number,
): AgentUsage | undefined {
  if (
    message.type !== "gemini" &&
    message.role !== "model" &&
    message.role !== "assistant"
  ) {
    return undefined;
  }
  const usage =
    asRecord(message.tokens) ??
    asRecord(message.usage) ??
    asRecord(message.usageMetadata);
  const inputTokens = tokenCount(
    usage,
    "input",
    "prompt",
    "inputTokens",
    "input_tokens",
    "promptTokenCount",
    "prompt_token_count",
  );
  if (inputTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens:
      tokenCount(
        usage,
        "output",
        "outputTokens",
        "output_tokens",
        "candidatesTokenCount",
        "candidates_token_count",
      ) ?? 0,
    cachedInputTokens:
      tokenCount(
        usage,
        "cached",
        "cachedTokens",
        "cachedInputTokens",
        "cached_input_tokens",
        "cachedContentTokenCount",
        "cached_content_token_count",
      ) ?? 0,
    usedTokens: inputTokens,
    contextWindow,
  };
}

function sameFileSystemPath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" || process.platform === "darwin"
      ? resolved.toLowerCase()
      : resolved;
  };
  return normalize(left) === normalize(right);
}

function geminiChatDirectories(cliHome: string, sourceFolder: string) {
  const geminiDirectory = path.join(cliHome, ".gemini");
  const tempDirectory = path.join(geminiDirectory, "tmp");
  const identifiers = new Set<string>();

  try {
    const registry = asRecord(
      JSON.parse(
        fs.readFileSync(path.join(geminiDirectory, "projects.json"), "utf8"),
      ),
    );
    const projects = asRecord(registry?.projects);
    for (const [projectPath, identifier] of Object.entries(projects ?? {})) {
      if (
        sameFileSystemPath(projectPath, sourceFolder) &&
        typeof identifier === "string"
      ) {
        identifiers.add(identifier);
      }
    }
  } catch {
    // Older Gemini CLI versions do not have the project registry.
  }

  identifiers.add(path.basename(path.resolve(sourceFolder)));
  identifiers.add(
    createHash("sha256").update(path.resolve(sourceFolder)).digest("hex"),
  );

  const directories = new Set<string>();
  for (const identifier of identifiers) {
    if (identifier && path.basename(identifier) === identifier) {
      directories.add(path.join(tempDirectory, identifier, "chats"));
    }
  }
  try {
    for (const entry of fs.readdirSync(tempDirectory, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        directories.add(path.join(tempDirectory, entry.name, "chats"));
      }
    }
  } catch {
    // Gemini has not created its local session directory yet.
  }
  return directories;
}

export function readRecordedGeminiUsage(
  cliHome: string,
  sourceFolder: string,
  conversationId: string,
  contextWindow: number,
) {
  const candidates: Array<{ path: string; modifiedAt: number }> = [];
  for (const directory of geminiChatDirectories(cliHome, sourceFolder)) {
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (
          !entry.isFile() ||
          (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl"))
        ) {
          continue;
        }
        const filePath = path.join(directory, entry.name);
        candidates.push({
          path: filePath,
          modifiedAt: fs.statSync(filePath).mtimeMs,
        });
      }
    } catch {
      // This candidate belongs to a different Gemini CLI storage layout.
    }
  }

  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const candidate of candidates) {
    const conversation = readGeminiConversation(candidate.path);
    if (conversation?.sessionId !== conversationId) {
      continue;
    }
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const message = conversation.messages[index];
      if (
        message.type === "gemini" ||
        message.role === "model" ||
        message.role === "assistant"
      ) {
        return geminiMessageUsage(message, contextWindow);
      }
    }
  }
  return undefined;
}
