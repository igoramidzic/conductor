import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      // Keep the native module external so Forge can rebuild and unpack it.
      external: ["node-pty"],
    },
  },
});
