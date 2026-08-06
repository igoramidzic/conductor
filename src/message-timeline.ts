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
