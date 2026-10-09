import { describe, expect, it } from "vitest";
import { handleClaudeHook } from "../src/core/claudehooks.js";
import { markRead, sendMessage, takeUnread, unreadFor } from "../src/core/messages.js";
import { initStore } from "../src/core/store.js";
import { AgentBrainMcpServer } from "../src/mcp/server.js";
import { tempRepo } from "./helpers.js";

function repo() {
  const r = tempRepo("agentbrain-msg-");
  initStore(r);
  return r;
}

describe("agents talking to each other", () => {
  it("delivers direct and broadcast messages once, never back to the sender", () => {
    const r = repo();
    sendMessage(r, { from: "vscode", to: "claude-code", text: "My merge needs README.md committed" });
    sendMessage(r, { from: "developer", to: "all", text: "Freeze the API for now" });
    expect(unreadFor(r, "claude-code").map((m) => m.text)).toEqual(["My merge needs README.md committed", "Freeze the API for now"]);
    expect(unreadFor(r, "vscode").map((m) => m.text)).toEqual(["Freeze the API for now"]);
    expect(takeUnread(r, "claude-code")).toContain("from vscode: My merge needs README.md committed");
    expect(unreadFor(r, "claude-code")).toEqual([]);
    markRead(r, "vscode");
    expect(unreadFor(r, "vscode")).toEqual([]);
  });

  it("lets an MCP agent send messages and hands it replies in its next tool result", async () => {
    const r = repo();
    const out: string[] = [];
    const server = new AgentBrainMcpServer({ root: r, output: { write: (s: string) => (out.push(s), true) } as any, agent: { id: "vscode", sessionId: "v1" } });
    const call = async (name: string, args: Record<string, unknown>) => {
      await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", id: out.length + 1, method: "tools/call", params: { name, arguments: args } }));
      return JSON.parse(out.at(-1)!).result.content[0].text as string;
    };
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Visual Studio Code" } } }));
    expect(await call("agentbrain_message", { to: "claude-code", text: "Please commit README.md" })).toMatch(/Sent to claude-code/);
    expect(unreadFor(r, "claude-code")).toHaveLength(1);
    sendMessage(r, { from: "claude-code", to: "vscode", text: "Committed, go ahead" });
    const listed = (server as any).tools().find((t: any) => t.name === "agentbrain_message").description;
    expect(listed).toContain("1 UNREAD MESSAGE");
    expect(await call("agentbrain_list_tasks", {})).toContain("from claude-code: Committed, go ahead");
  });

  it("hands Claude Code its messages while it works, and before it stops", () => {
    const r = repo();
    sendMessage(r, { from: "vscode", to: "claude-code", text: "I'm editing page.ts, avoid it" });
    const during = JSON.parse(handleClaudeHook({ session_id: "c1", cwd: r, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a" } }));
    expect(during.hookSpecificOutput.additionalContext).toContain("avoid it");
    sendMessage(r, { from: "developer", to: "all", text: "Wrap up soon" });
    const stop = JSON.parse(handleClaudeHook({ session_id: "c1", cwd: r, hook_event_name: "Stop" }));
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("Wrap up soon");
    expect(handleClaudeHook({ session_id: "c1", cwd: r, hook_event_name: "Stop" })).toBe("");
  });
});

describe("agents delegating to agents", () => {
  it("lets the lead split off a subtask and tells it when the piece is ready", async () => {
    const { createTask, updateTask, takeOver } = await import("../src/core/actions.js");
    const { getProject, getTask, listTasks } = await import("../src/core/store.js");
    const r = repo();
    const parent = createTask(r, "Ship the settings page");
    takeOver(r, parent.id, { id: "claude-code", sessionId: "c1" });
    const out: string[] = [];
    const server = new AgentBrainMcpServer({ root: r, output: { write: (s: string) => (out.push(s), true) } as any, agent: { id: "claude-code", sessionId: "c1" } });
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code" } } }));
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agentbrain_delegate", arguments: { objective: "Write the settings API tests", worker: "any", parent_task_id: parent.id } } }));
    expect(JSON.parse(out.at(-1)!).result.content[0].text).toMatch(/Delegated task-\d+ to Next agent you open/);

    const child = listTasks(r).find((t) => t.objective === "Write the settings API tests")!;
    expect(child).toMatchObject({ parent: parent.id, requestedBy: "claude-code" });
    // The developer's active task is untouched by the subtask.
    expect(getProject(r).activeTaskId).toBe(parent.id);

    updateTask(r, child.id, { status: "review", agent: { id: "codex", sessionId: "x1" } });
    expect(takeUnread(r, "claude-code")).toContain(`${child.id} "Write the settings API tests", is now review`);
    expect(getTask(r, parent.id).id).toBe(parent.id);
  });
});
