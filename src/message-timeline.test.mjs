import assert from "node:assert/strict";
import test from "node:test";

import {
  appendMessageText,
  ensureActivityPart,
  startTextPart,
  timelineBlocks,
  visibleMessageParts,
} from "./message-timeline.ts";

function assistantMessage() {
  return {
    id: "message-1",
    role: "assistant",
    content: "",
    chunks: [],
    createdAt: 0,
    status: "thinking",
    activities: [],
    parts: [],
  };
}

test("preserves text and tool order while a response streams", () => {
  let message = startTextPart(assistantMessage(), "text-1");
  message = appendMessageText(message, "First update.", "text-1");
  message = {
    ...message,
    parts: ensureActivityPart(message, "tool-1"),
  };
  message = startTextPart(message, "text-2");
  message = appendMessageText(message, "Second update.", "text-2");
  message = {
    ...message,
    parts: ensureActivityPart(message, "tool-2"),
  };

  assert.deepEqual(
    message.parts.map((part) =>
      part.type === "text" ? part.content : part.activityId,
    ),
    ["First update.", "tool-1", "Second update.", "tool-2"],
  );
  assert.equal(message.content, "First update.\n\nSecond update.");
});

test("groups only adjacent activities in the response timeline", () => {
  const activities = [
    {
      id: "tool-1",
      kind: "command",
      label: "Read files",
      status: "complete",
    },
    {
      id: "tool-2",
      kind: "tool",
      label: "Viewed image",
      status: "complete",
    },
    {
      id: "tool-3",
      kind: "file-change",
      label: "Edited file",
      status: "complete",
    },
  ];
  const message = {
    ...assistantMessage(),
    status: "complete",
    activities,
    parts: [
      { id: "text-1", type: "text", content: "Before.", chunks: ["Before."] },
      { id: "activity-1", type: "activity", activityId: "tool-1" },
      { id: "activity-2", type: "activity", activityId: "tool-2" },
      {
        id: "text-2",
        type: "text",
        content: "Between.",
        chunks: ["Between."],
      },
      { id: "activity-3", type: "activity", activityId: "tool-3" },
      { id: "text-3", type: "text", content: "After.", chunks: ["After."] },
    ],
  };

  const blocks = timelineBlocks(
    visibleMessageParts(message, activities),
    new Map(activities.map((activity) => [activity.id, activity])),
  );

  assert.deepEqual(
    blocks.map((block) =>
      block.type === "text"
        ? block.part.content
        : block.activities.map((activity) => activity.id),
    ),
    ["Before.", ["tool-1", "tool-2"], "Between.", ["tool-3"], "After."],
  );
});

test("settles a tool group as soon as the next text part starts", () => {
  const activities = [
    {
      id: "tool-1",
      kind: "command",
      label: "Read files",
      status: "complete",
    },
    {
      id: "tool-2",
      kind: "file-change",
      label: "Edited file",
      status: "running",
    },
  ];
  let message = {
    ...assistantMessage(),
    activities,
    parts: [
      { id: "text-1", type: "text", content: "Before.", chunks: ["Before."] },
      { id: "activity-1", type: "activity", activityId: "tool-1" },
      { id: "activity-2", type: "activity", activityId: "tool-2" },
    ],
  };
  const activitiesById = new Map(
    activities.map((activity) => [activity.id, activity]),
  );

  let blocks = timelineBlocks(
    visibleMessageParts(message, activities),
    activitiesById,
  );
  assert.equal(blocks.at(-1)?.type, "activities");
  assert.equal(blocks.at(-1)?.settled, false);

  message = startTextPart(message, "text-2");
  blocks = timelineBlocks(
    visibleMessageParts(message, activities),
    activitiesById,
  );
  assert.equal(blocks.at(-1)?.type, "activities");
  assert.equal(blocks.at(-1)?.settled, true);
});

test("keeps a final-only response visible when no text delta arrived", () => {
  const message = {
    ...assistantMessage(),
    content: "Final-only response.",
    chunks: ["Final-only response."],
    status: "complete",
  };

  assert.deepEqual(
    visibleMessageParts(message, []).map((part) => part.content),
    ["Final-only response."],
  );
});
