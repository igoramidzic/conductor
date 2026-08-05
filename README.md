# Conductor

Conductor is a local Electron workspace for running Gemini CLI, Claude Code,
and Codex conversations alongside a terminal. Projects and conversations are
kept locally, and each agent runs in the source folder selected for its project.

## Prerequisites

- [Node.js](https://nodejs.org/) (the current LTS release is recommended)
- [pnpm](https://pnpm.io/) 11.20.0 (the version pinned in `package.json`)
- At least one supported agent CLI, installed and authenticated:
  - `gemini` for Gemini CLI
  - `claude` for Claude Code
  - `codex` for Codex CLI

If pnpm is not already installed, Corepack can provide the pinned version:

```bash
corepack enable
corepack install
pnpm --version
```

Follow the setup instructions for your chosen agent, then confirm that its
executable is available before starting Conductor. For example:

```bash
gemini --version
claude --version
codex --version
```

Only one agent CLI is required. Conductor shows models for the agents it can
find.

## Run locally

Clone the repository, install its dependencies, and start the development app:

```bash
git clone https://github.com/igoramidzic/conductor.git
cd conductor
pnpm install
pnpm start
```

Electron Forge starts the main process and Vite renderer in development mode,
then opens the desktop app. Keep the `pnpm start` process running while using
the app; stop it with `Ctrl+C` in the launching terminal.

On first use:

1. Add a project and choose its source folder.
2. Create a conversation under that project.
3. Select an available agent and model.
4. Choose the access mode you want the agent to have, then send a prompt.

The built-in terminal opens in the selected project's source folder.

## Worktree sessions

For a project-backed conversation, use the **Local** picker above the composer
to choose where the session runs:

- **Local** runs the agent and terminal directly in the selected project folder.
- **Worktree** creates a session-owned Git branch and checkout from the
  project's current commit when the first prompt is sent.

Managed worktrees are stored under
`~/.conductor/worktrees/<session-id>/<repository>`. Conductor names the
worktree from the first prompt, shows that name in the session header, and lets
you inspect the branch, base ref, and path or reveal the checkout in your file
manager. Archiving a session keeps its worktree and branch intact.

## Agent executable discovery

Conductor looks for each agent executable in this order:

1. The provider-specific environment variable: `GEMINI_PATH`, `CLAUDE_PATH`,
   or `CODEX_PATH`
2. `~/.local/bin/gemini`, `~/.local/bin/claude`, or `~/.local/bin/codex`
3. The directories in `PATH`

If an installed CLI does not appear in Conductor, set its variable to the
absolute executable path before launching the app:

```bash
CODEX_PATH=/absolute/path/to/codex pnpm start
```

Use `command -v gemini`, `command -v claude`, or `command -v codex` to find an
installed executable on macOS or Linux.

## Quality checks

Run these before submitting a change:

```bash
pnpm lint
pnpm typecheck
pnpm package
```

- `pnpm lint` checks the repository with Biome.
- `pnpm typecheck` runs TypeScript without emitting files.
- `pnpm package` creates an unpacked app in `out/` for the current platform.

To create a platform-specific distributable with the configured Electron Forge
makers, run:

```bash
pnpm make
```

Build artifacts are written to `out/`.

## Troubleshooting

- **No models are available:** make sure at least one supported CLI is installed
  and authenticated, then restart Conductor from the same terminal where its
  version command succeeds.
- **Conductor says an agent is not installed:** check `command -v <agent>` and,
  if necessary, use the corresponding absolute-path environment variable shown
  above.
- **A native dependency fails during installation:** install the platform's
  native build tools (Xcode Command Line Tools on macOS), then retry
  `pnpm install`.
- **The app shows stale development behavior:** stop the running Forge process
  and start it again with `pnpm start`.

On macOS, the development process launches Electron from this repository's
`node_modules/electron/dist/Electron.app`. It is separate from any other app
named Conductor that may be installed on the machine.
