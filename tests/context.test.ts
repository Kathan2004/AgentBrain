import { describe, expect, it } from "vitest";
import { buildPrompt, createTask, takeOver, updateTask } from "../src/core/actions.js";
import { recordActivity } from "../src/core/activity.js";
import { changesSince, sharedContext } from "../src/core/context.js";
import { getTask, initStore, saveTask } from "../src/core/store.js";
import { remember } from "../src/core/vault.js";
import { AgentBrainMcpServer } from "../src/mcp/server.js";
import { tempRepo } from "./helpers.js";

function project() {
  const repo = tempRepo("agentbrain-ctx-");
  initStore(repo);
  // History every agent should learn from, whoever picks the next task up.
  const old = createTask(repo, "Add the login form");
  saveTask(repo, { ...getTask(repo, old.id), status: "done", reviews: [{ verdict: "changes", reviewer: "claude-code", worker: "codex", notes: "Never store tokens in localStorage", at: new Date().toISOString() }] });
  remember(repo, { title: "Auth tokens live in the keychain", text: "Use the keychain helper for every auth token.", author: "claude-code" });
  const busy = createTask(repo, "Rewrite the settings page");
  takeOver(repo, busy.id, { id: "vscode", sessionId: "v1" });
  recordActivity(repo, { agent: "vscode", task: busy.id, kind: "edit", text: "Edited src/settings.ts", files: ["src/settings.ts"] });
  const task = createTask(repo, "Add token refresh to the auth flow");
  return { repo, task };
}

describe("shared context", () => {
  it("gives every agent the same memory: lessons, kept notes relevant to the task, and who is working on what", () => {
    const { repo, task } = project();
    const ctx = sharedContext(repo, { taskId: task.id, objective: task.objective });
    expect(ctx).toContain("Never store tokens in localStorage");
    expect(ctx).toContain("Auth tokens live in the keychain");
    expect(ctx).toContain("vscode is working on");
    expect(ctx).toContain("src/settings.ts");
  });

  it("puts it in the brief background runs and chat agents get, and in what MCP agents get", async () => {
    const { repo, task } = project();
    const prompt = buildPrompt(repo, task.id, "agentbrain");
    expect(prompt).toContain("Never store tokens in localStorage");
    expect(prompt).toContain("Auth tokens live in the keychain");
    const server = new AgentBrainMcpServer({ root: repo, output: { write: () => true } as any, agent: { id: "codex", sessionId: "c1" } });
    expect(server.instructions()).toContain("Never store tokens in localStorage");
    expect(server.instructions()).toContain("Auth tokens live in the keychain");
  });

  it("tells an agent mid-task what other agents decided since its last step", () => {
    const { repo, task } = project();
    const before = new Date().toISOString();
    updateTask(repo, task.id, { decisions: ["Refresh tokens rotate on every use"], agent: { id: "claude-code", sessionId: "k1" } });
    expect(changesSince(repo, before, "codex")).toContain("claude-code");
    expect(changesSince(repo, before, "codex")).toContain("Refresh tokens rotate on every use");
    expect(changesSince(repo, before, "claude-code")).toBe("");
  });
});
