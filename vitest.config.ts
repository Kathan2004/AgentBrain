import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our tests: editor extensions may create worktree copies inside the repo.
    include: ["tests/**/*.test.ts"],
    // CLI tests spawn node and git many times; on machines with endpoint
    // security scanning every process start, full parallelism starves them.
    testTimeout: 90_000,
    maxWorkers: 4,
  },
});
