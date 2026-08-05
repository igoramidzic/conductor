import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import "@/index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
