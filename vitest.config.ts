import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests must never reach the real agents installed on the machine: drop PATH
// folders that hold one (e.g. ~/.local/bin with the ACP adapters or Ollama).
const AGENTS = ["claude", "codex", "claude-code-acp", "codex-acp", "gemini", "ollama", "copilot", "cursor-agent"];
const PATH = (process.env.PATH ?? "").split(path.delimiter)
  .filter((dir) => dir && !AGENTS.some((name) => fs.existsSync(path.join(dir, name))))
  .join(path.delimiter);

export default defineConfig({
  test: {
    // Only our tests: editor extensions may create worktree copies inside the repo.
    include: ["tests/**/*.test.ts"],
    // CLI tests spawn node and git many times; on machines with endpoint
    // security scanning every process start, full parallelism starves them.
    testTimeout: 90_000,
    maxWorkers: 4,
    // Only stubs on PATH count: not Claude Code bundled in the Claude app, Codex in Codex.app.
    env: { AGENTBRAIN_ONLY_PATH: "1", PATH },
  },
});
