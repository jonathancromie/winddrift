import { defineConfig } from "vitest/config";

export default defineConfig({
  worker: { format: "es" },
  // public/ only holds local development frames, which production serves from R2.
  build: { target: "es2022", copyPublicDir: false },
  test: { environment: "node", include: ["src/**/*.test.ts", "worker/**/*.test.ts"] },
});
