import { defineConfig } from "vitest/config";

export default defineConfig({
  worker: { format: "es" },
  build: { target: "es2022" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
