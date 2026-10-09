import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our tests: editor extensions may create worktree copies inside the repo.
    include: ["tests/**/*.test.ts"],
    // CLI tests spawn node and git many times; on machines with endpoint
    // security scanning every process start, full parallelism starves them.
    testTimeout: 90_000,
    maxWorkers: 4,
    // Tests must never reach the real agents installed on the machine (Claude Code
    // bundled in the Claude app, Codex in Codex.app): only stubs on PATH count.
    env: { AGENTBRAIN_ONLY_PATH: "1" },
  },
});
