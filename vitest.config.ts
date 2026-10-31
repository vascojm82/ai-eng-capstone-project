import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lib/evals/**/*.test.ts"],
    // Starts the API server on its own port (EVALS_PORT, default 3100) for the evals
    globalSetup: ["lib/evals/server.ts"],
  },
});
