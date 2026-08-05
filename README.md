# Conductor

A minimal Electron desktop shell built with React, TypeScript, Tailwind CSS,
and shadcn/ui components backed by Base UI.

## Development

```bash
pnpm install
pnpm start
```

## Quality checks

```bash
pnpm lint
pnpm typecheck
pnpm package
```

The macOS build uses Electron's native traffic lights. The adjacent shadcn
sidebar trigger remains fixed while the sidebar and workspace transition
underneath it.
