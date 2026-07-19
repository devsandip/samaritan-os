import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `outDir: dist` is not a default worth changing: src/api/server.ts serves
// repoRoot()/ui/dist through @fastify/static with an SPA fallback, so the build
// output path is part of the server contract.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Standalone `pnpm -C ui dev` still talks to the real daemon. Same-origin in
    // production (Fastify serves both), so no CORS handling exists server-side
    // and none is needed here either.
    proxy: {
      "/api": { target: "http://127.0.0.1:4173", changeOrigin: false },
      "/healthz": { target: "http://127.0.0.1:4173", changeOrigin: false },
    },
  },
});
