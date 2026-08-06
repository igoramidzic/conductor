import assert from "node:assert/strict";
import test from "node:test";

import {
  geminiStartupFailure,
  redactAgentArguments,
  redactPrompt,
  trailingDiagnosticLines,
} from "./agent-diagnostics.ts";

test("detects Gemini authentication prompts that cannot complete headlessly", () => {
  assert.match(
    geminiStartupFailure(
      "Please run Gemini CLI in an interactive terminal to authenticate",
    ),
    /interactive authentication/,
  );
  assert.equal(geminiStartupFailure("Loading extension…"), undefined);
});

test("keeps only the final non-empty diagnostic lines", () => {
  assert.equal(
    trailingDiagnosticLines("first\n\nsecond\nthird\nfourth", 2),
    "third\nfourth",
  );
});

test("redacts prompts and conversation identifiers from logged arguments", () => {
  assert.deepEqual(
    redactAgentArguments(
      "gemini",
      [
        "--approval-mode",
        "default",
        "--resume",
        "session-secret",
        "--prompt",
        "private prompt",
      ],
      "private prompt",
    ),
    [
      "--approval-mode",
      "default",
      "--resume",
      "<conversation-id>",
      "--prompt",
      "<prompt:14 characters>",
    ],
  );
});

test("redacts prompt text from diagnostics", () => {
  assert.equal(
    redactPrompt("Request failed for private prompt", "private prompt"),
    "Request failed for <prompt:14 characters>",
  );
});
