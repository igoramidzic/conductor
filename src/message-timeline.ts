import type { AgentActivity, ChatMessage, ChatMessagePart } from "@/types";

export type ChatTextPart = Extract<ChatMessagePart, { type: "text" }>;

export type TimelineBlock =
  | { id: string; type: "text"; part: ChatTextPart }
  | {
      id: string;
      type: "activities";
      activities: AgentActivity[];
      settled: boolean;
    };

function summaryList(items: string[]) {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function toolSummary(activities: AgentActivity[]) {
  const namedTools = new Map<string, { label: string; count: number }>();
  let unnamedToolCount = 0;

  for (const activity of activities) {
    if (activity.kind !== "tool" && activity.kind !== "other") {
      continue;
    }
    const label = activity.label.trim();
    if (!label || /^(?:(?:used|using) (?:a )?)?tool$/i.test(label)) {
      unnamedToolCount += 1;
      continue;
    }
    const key = label.toLocaleLowerCase();
    const existing = namedTools.get(key);
    namedTools.set(key, {
      label: existing?.label ?? label,
      count: (existing?.count ?? 0) + 1,
    });
  }

  const descriptions = [...namedTools.values()].map(({ label, count }) => {
    if (count === 1) {
      return label;
    }
    return count === 2 ? `${label} twice` : `${label} ${count} times`;
  });
  if (unnamedToolCount > 0 && descriptions.length > 0) {
    descriptions.push(
      unnamedToolCount === 1
        ? "another tool"
        : `${unnamedToolCount} other tools`,
    );
  }
  if (descriptions.length > 0) {
    return `used ${summaryList(descriptions)}`;
  }
  if (unnamedToolCount > 0) {
    return `used ${unnamedToolCount === 1 ? "a tool" : "tools"}`;
  }
  return null;
}

export function activitySummary(activities: AgentActivity[]) {
  const hasReasoning = activities.some(
    (activity) => activity.kind === "reasoning",
  );
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
  const phrases = [
    hasFileChanges ? "edited files" : null,
    hasReads ? "read files" : null,
    hasFileLists ? "listed files" : null,
    hasProjectSearches ? "searched the project" : null,
    hasWebSearches ? "searched the web" : null,
    toolSummary(activities),
    commandCount > 0
      ? `ran ${commandCount === 1 ? "a command" : "commands"}`
      : null,
  ].filter((phrase): phrase is string => phrase !== null);
  const summary =
    phrases.join(", ") ||
    (hasReasoning ? "thought through the request" : "worked on the request");
  return `${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}`;
}

function fallbackTextPart(message: ChatMessage): ChatTextPart | undefined {
  if (!message.content) {
    return undefined;
  }
  return {
    id: `${message.id}-text-0`,
    type: "text",
    content: message.content,
    chunks: message.chunks.length > 0 ? message.chunks : [message.content],
  };
}

export function messageParts(message: ChatMessage): ChatMessagePart[] {
  if (Array.isArray(message.parts)) {
    const fallback = message.parts.some(
      (part) => part.type === "text" && part.content.length > 0,
    )
      ? undefined
      : fallbackTextPart(message);
    return fallback ? [...message.parts, fallback] : message.parts;
  }

  const fallback = fallbackTextPart(message);
  return [
    ...(message.activities ?? []).map(
      (activity): ChatMessagePart => ({
        id: `activity-${activity.id}`,
        type: "activity",
        activityId: activity.id,
      }),
    ),
    ...(fallback ? [fallback] : []),
  ];
}

export function ensureActivityPart(message: ChatMessage, activityId: string) {
  const parts = messageParts(message);
  if (
    parts.some(
      (part) => part.type === "activity" && part.activityId === activityId,
    )
  ) {
    return parts;
  }
  return [
    ...parts,
    {
      id: `activity-${activityId}`,
      type: "activity" as const,
      activityId,
    },
  ];
}

export function startTextPart(
  message: ChatMessage,
  partId: string,
): ChatMessage {
  const parts = messageParts(message);
  if (parts.some((part) => part.type === "text" && part.id === partId)) {
    return message.parts ? message : { ...message, parts };
  }
  return {
    ...message,
    parts: [...parts, { id: partId, type: "text", content: "", chunks: [] }],
  };
}

function responseBlockSeparator(content: string) {
  if (!content) {
    return "";
  }
  if (/\n\s*\n$/.test(content)) {
    return "";
  }
  return content.endsWith("\n") ? "\n" : "\n\n";
}

export function appendMessageText(
  message: ChatMessage,
  text: string,
  requestedPartId?: string,
): ChatMessage {
  const parts = messageParts(message);
  let partIndex = requestedPartId
    ? parts.findIndex(
        (part) => part.type === "text" && part.id === requestedPartId,
      )
    : -1;
  if (partIndex === -1 && !requestedPartId && parts.at(-1)?.type === "text") {
    partIndex = parts.length - 1;
  }

  const nextParts = [...parts];
  if (partIndex === -1) {
    partIndex = nextParts.length;
    nextParts.push({
      id: requestedPartId ?? `${message.id}-text-${partIndex}`,
      type: "text",
      content: "",
      chunks: [],
    });
  }

  const currentPart = nextParts[partIndex];
  if (currentPart?.type !== "text") {
    return message;
  }
  const startsBlock = currentPart.content.length === 0;
  const separator = startsBlock ? responseBlockSeparator(message.content) : "";
  nextParts[partIndex] = {
    ...currentPart,
    content: `${currentPart.content}${text}`,
    chunks: [...currentPart.chunks, text],
  };

  return {
    ...message,
    content: `${message.content}${separator}${text}`,
    chunks: [...message.chunks, ...(separator ? [separator] : []), text],
    parts: nextParts,
  };
}

export function visibleMessageParts(
  message: ChatMessage,
  activities: AgentActivity[],
): ChatMessagePart[] {
  const activityIds = new Set(activities.map((activity) => activity.id));
  return messageParts(message).filter(
    (part) =>
      part.type === "text" ||
      (part.type === "activity" && activityIds.has(part.activityId)),
  );
}

export function timelineBlocks(
  parts: ChatMessagePart[],
  activitiesById: Map<string, AgentActivity>,
) {
  const blocks: TimelineBlock[] = [];
  let activityGroup: AgentActivity[] = [];
  let activityGroupId = "";
  const flushActivities = (settled: boolean) => {
    if (activityGroup.length === 0) {
      return;
    }
    blocks.push({
      id: activityGroupId,
      type: "activities",
      activities: activityGroup,
      settled,
    });
    activityGroup = [];
    activityGroupId = "";
  };

  for (const part of parts) {
    if (part.type === "activity") {
      const activity = activitiesById.get(part.activityId);
      if (!activity) {
        continue;
      }
      activityGroupId ||= `activities-${part.id}`;
      activityGroup.push(activity);
      continue;
    }
    flushActivities(true);
    if (part.content) {
      blocks.push({ id: `text-${part.id}`, type: "text", part });
    }
  }
  flushActivities(false);
  return blocks;
}
