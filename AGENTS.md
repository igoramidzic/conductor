# Repository instructions

## shadcn components

- Import any needed shadcn/ui component with
  `npx shadcn@latest add <component>` before using it. Do not recreate shadcn
  components from scratch or from memory.
- Treat generated component files as the starting point and preserve intentional
  local modifications when adding or updating other components.

## Local app identification

- The development build launched by `pnpm start` runs from
  `/Users/igoramidzic/code/conductor/node_modules/electron/dist/Electron.app`.
  Its generic `com.github.Electron` bundle identifier is shared by other local
  projects, so the bundle identifier alone is not a safe automation target.
- A separate, unrelated application named `Conductor` is installed on this Mac.
  Never target the display name `Conductor`, `com.conductor.app`, or
  `com.electron.conductor` when inspecting or automating this repository.
- For native UI inspection, first confirm the repository's development process
  is running, then target the full Electron app path above explicitly.
