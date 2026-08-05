import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Conductor renderer error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-lg rounded-2xl border bg-card p-6 shadow-sm">
          <p className="text-xs font-semibold tracking-[0.08em] text-destructive uppercase">
            Renderer error
          </p>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            Conductor hit an unexpected error
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The app kept this diagnostic screen available instead of going
            blank.
          </p>
          <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
            {error.message}
          </pre>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              className="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button
              type="button"
              className="h-8 rounded-lg border bg-background px-3 text-xs font-medium hover:bg-muted"
              onClick={() => void window.electron.openDevTools()}
            >
              Open Developer Tools
            </button>
          </div>
        </section>
      </main>
    );
  }
}
