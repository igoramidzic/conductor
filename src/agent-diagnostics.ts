import type { AgentProvider } from "./types";

const GEMINI_AUTH_FAILURES: Array<{
  pattern: RegExp;
  message: string;
}> = [
  {
    pattern:
      /Authentication consent could not be obtained|Error authenticating|Please run Gemini CLI in an interactive terminal|Please visit the following URL to authorize|Enter the authorization code/i,
    message:
      "Gemini needs interactive authentication. Run gemini once in a terminal, finish signing in with your work account, then retry in Conductor.",
  },
  {
    pattern: /This client is no longer supported for Gemini Code Assist/i,
    message:
      "This Gemini CLI authentication client is not supported for the signed-in account. Run gemini in a terminal to see the account-specific setup instructions, then retry in Conductor.",
  },
];

export function geminiStartupFailure(stderr: string) {
  return GEMINI_AUTH_FAILURES.find(({ pattern }) => pattern.test(stderr))
    ?.message;
}

export function trailingDiagnosticLines(value: string, lineLimit = 4) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lineLimit)
    .join("\n");
}

export function redactPrompt(value: string, prompt: string) {
  return prompt
    ? value.replaceAll(prompt, `<prompt:${prompt.length} characters>`)
    : value;
}

export function redactAgentArguments(
  provider: AgentProvider,
  args: string[],
  prompt: string,
) {
  return args.map((argument, index) => {
    const previous = args[index - 1];
    if (argument === prompt || previous === "--prompt") {
      return `<prompt:${prompt.length} characters>`;
    }
    if (previous === "--resume" || previous === "--conversation") {
      return "<conversation-id>";
    }
    if (provider === "claude" && index === args.length - 1) {
      return `<prompt:${prompt.length} characters>`;
    }
    return argument;
  });
}
