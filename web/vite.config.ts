/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The console always calls the backend at the same-origin path `/api`.
// Vite proxies it to the FastAPI server, so there is no CORS setup and no
// backend URL baked into the bundle. Override the target with BACKEND_URL.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.BACKEND_URL || "http://localhost:8000";
  const proxy = { "/api": { target, changeOrigin: true } };
  return {
    plugins: [react()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    // livekit-client (~590 kB) is lazy-loaded on the first live call, so its
    // chunk size does not affect first paint.
    build: { chunkSizeWarningLimit: 700 },
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  };
});
