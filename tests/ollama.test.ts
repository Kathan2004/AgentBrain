import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeOutput } from "../src/core/printrun.js";
import { localModel, ollamaEnv, setLocalModel } from "../src/core/ollama.js";

describe("local model (Ollama)", () => {
  it("points Claude Code's CLI at Ollama for every model tier, with no Anthropic key", () => {
    const env = ollamaEnv("agentbrain-qwen3");
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/.+:11434$/);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_MODEL).toBe("agentbrain-qwen3");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("agentbrain-qwen3");
  });

  it("remembers the chosen model per user", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-home-"));
    setLocalModel("llama3.1:8b", home);
    expect(localModel(home)).toBe("llama3.1:8b");
  });

  it("reads its tool calls into the feed like Claude's", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/r/src/a.ts" } }] } });
    expect(describeOutput("ollama", line, "/r")?.kind).toBe("edit");
  });
});
