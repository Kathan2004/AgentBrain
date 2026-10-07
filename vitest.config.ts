import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our tests: editor extensions may create worktree copies inside the repo.
    include: ["tests/**/*.test.ts"],
    // CLI tests spawn node and git repeatedly.
    testTimeout: 30_000,
  },
});
