import type { AgentAccessMode, AgentProvider } from "./types";

export type AgentAccessModeOption = {
  value: AgentAccessMode;
  label: string;
  description: string;
};

const ACCESS_MODES = {
  codex: [
    {
      value: "read-only",
      label: "Ask for approval",
      description: "Reads freely and asks before making changes.",
    },
    {
      value: "auto",
      label: "Auto",
      description: "Works in this project and asks before going beyond it.",
    },
    {
      value: "full-access",
      label: "Full access",
      description: "Runs without approval or sandbox restrictions.",
    },
  ],
  claude: [
    {
      value: "ask",
      label: "Ask permissions",
      description: "Asks before edits, commands, and network access.",
    },
    {
      value: "accept-edits",
      label: "Accept edits",
      description: "Edits project files automatically; asks for other tools.",
    },
    {
      value: "plan",
      label: "Plan mode",
      description: "Explores and proposes a plan without changing files.",
    },
    {
      value: "full-access",
      label: "Full access",
      description: "Bypasses Claude's permission checks.",
    },
  ],
  gemini: [
    {
      value: "ask",
      label: "Ask permissions",
      description: "Uses the agent's normal permission prompts.",
    },
    {
      value: "accept-edits",
      label: "Accept edits",
      description: "Allows edits while keeping other approvals in place.",
    },
    {
      value: "plan",
      label: "Plan mode",
      description: "Explores and proposes a plan without changing files.",
    },
    {
      value: "full-access",
      label: "Full access",
      description: "Skips all tool permission prompts.",
    },
  ],
} as const satisfies Record<AgentProvider, readonly AgentAccessModeOption[]>;

const PROVIDER_LABELS = {
  gemini: "Gemini",
  claude: "Claude",
  codex: "Codex",
} as const satisfies Record<AgentProvider, string>;

export function getAgentAccessModes(provider: AgentProvider) {
  return ACCESS_MODES[provider];
}

export function getAgentProviderLabel(provider: AgentProvider) {
  return PROVIDER_LABELS[provider];
}

export function resolveAgentAccessMode(
  provider: AgentProvider,
  value?: AgentAccessMode,
): AgentAccessMode {
  const options = getAgentAccessModes(provider);
  return options.some((option) => option.value === value)
    ? (value as AgentAccessMode)
    : options[0].value;
}

export function getAgentAccessArgs(
  provider: AgentProvider,
  requestedMode?: AgentAccessMode,
) {
  const mode = resolveAgentAccessMode(provider, requestedMode);

  if (provider === "codex") {
    if (mode === "full-access") {
      return ["--dangerously-bypass-approvals-and-sandbox"];
    }
    if (mode === "auto") {
      return [
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
      ];
    }
    return ["--sandbox", "read-only", "--ask-for-approval", "on-request"];
  }

  if (provider === "claude") {
    const claudeMode =
      mode === "accept-edits"
        ? "acceptEdits"
        : mode === "plan"
          ? "plan"
          : mode === "full-access"
            ? "bypassPermissions"
            : "default";
    return ["--permission-mode", claudeMode];
  }

  if (mode === "full-access") {
    return ["--approval-mode", "yolo"];
  }
  if (mode === "accept-edits") {
    return ["--approval-mode", "auto_edit"];
  }
  return ["--approval-mode", mode === "plan" ? "plan" : "default"];
}
