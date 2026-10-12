import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { readActivity } from "../src/core/activity.js";
import { handleClaudeHook } from "../src/core/claudehooks.js";
import { initStore, listSessions } from "../src/core/store.js";
import { sessionPresent } from "../src/ui/model.js";
import { tempRepo } from "./helpers.js";

describe("what a Claude session is working on", () => {
  it("stops tagging its work with a task once that task is done", () => {
    const r = tempRepo("agentbrain-sesstask-");
    initStore(r);
    const task = createTask(r, "Two bugs, with tests");
    handleClaudeHook({ session_id: "s1", cwd: r, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(readActivity(r).at(-1)?.task).toBe(task.id);
    updateTask(r, task.id, { status: "done" });
    handleClaudeHook({ session_id: "s1", cwd: r, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pwd" } });
    const last = readActivity(r).filter((e) => e.text.includes("pwd")).at(-1);
    expect(last).toBeTruthy();
    expect(last?.task).toBeUndefined();
  });
});

describe("agents present", () => {
  it("counts a session as present only while it's been heard from recently", () => {
    const r = tempRepo("agentbrain-present-");
    initStore(r);
    handleClaudeHook({ session_id: "s1", cwd: r, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    const [s] = listSessions(r);
    expect(sessionPresent(s)).toBe(true);
    expect(sessionPresent({ ...s, lastSeenAt: new Date(Date.now() - 3_600_000).toISOString() })).toBe(false);
    expect(sessionPresent({ ...s, endedAt: new Date().toISOString() })).toBe(false);
  });
});

describe("a long brief", () => {
  it("starts with its first sentence as the to-do, not the whole spec", async () => {
    const { firstStep } = await import("../src/core/actions.js");
    const spec = "Redesign the terminal console to match the web control room. " + "Keep every command. ".repeat(20);
    expect(firstStep(spec)).toBe("Redesign the terminal console to match the web control room.");
    expect(firstStep("Fix the login bug")).toBe("Fix the login bug");
    const r = tempRepo("agentbrain-brief-");
    initStore(r);
    expect(createTask(r, spec).remaining).toEqual(["Redesign the terminal console to match the web control room."]);
  });
});

describe("AgentBrain's brief to a background run", () => {
  it("is shown as AgentBrain starting the agent, not as the developer asking", () => {
    delete process.env.AGENTBRAIN_SESSION; // when an agent runs this suite itself
    const r = tempRepo("agentbrain-brief-prompt-");
    initStore(r);
    handleClaudeHook({ session_id: "s9", cwd: r, hook_event_name: "UserPromptSubmit", prompt: "You are starting AgentBrain task task-1. Nobody has worked on it yet." });
    handleClaudeHook({ session_id: "s9", cwd: r, hook_event_name: "UserPromptSubmit", prompt: "Please also fix the README" });
    const events = readActivity(r).filter((e) => e.kind === "prompt" || e.kind === "handoff");
    expect(events.map((e) => [e.agent, e.kind])).toEqual([["agentbrain", "handoff"], ["claude-code", "prompt"]]);
  });
});

describe("the words behind a delegated task", () => {
  it("keeps what the developer last asked the agent that delegated it", async () => {
    const { developerRequest } = await import("../src/core/delegate.js");
    delete process.env.AGENTBRAIN_SESSION;
    const r = tempRepo("agentbrain-request-");
    initStore(r);
    handleClaudeHook({ session_id: "s5", cwd: r, hook_event_name: "UserPromptSubmit", prompt: "make the terminal UI like the web one" });
    expect(developerRequest(r, "claude-code")).toBe("make the terminal UI like the web one");
    expect(developerRequest(r, "developer")).toBeUndefined();
    expect(developerRequest(r, "claude-code", Date.now() + 3 * 3_600_000)).toBeUndefined();
  });
});
