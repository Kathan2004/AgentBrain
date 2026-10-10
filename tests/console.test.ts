import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { delegate, listWorkers } from "../src/core/delegate.js";
import { getTask, initStore } from "../src/core/store.js";
import { FeedFormatter, connectorLines, inputBox, suggestions, welcomeBox } from "../src/ui/console.js";
import { visibleLength } from "../src/ui/tui.js";
import { CLI, stubAgent, tempRepo } from "./helpers.js";

const FAKE = path.resolve("tests/fixtures/fake-acp-agent.mjs");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("console rendering", () => {
  it("draws the prompt box at exactly the terminal width, wrapping long input", () => {
    const empty = inputBox(60, "", 0);
    expect(empty.lines.map(visibleLength)).toEqual([60]);
    expect(plain(empty.lines[0])).toContain("Describe a task");
    expect([empty.cursorRow, empty.cursorCol]).toEqual([0, 2]);

    const long = "x".repeat(70);
    const box = inputBox(60, long, 70);
    expect(box.lines).toHaveLength(2);
    expect(box.lines.every((l) => visibleLength(l) === 60)).toBe(true);
    expect([box.cursorRow, box.cursorCol]).toEqual([1, 2 + (70 - 58)]);
  });

  it("suggests slash commands while the command name is being typed", () => {
    expect(suggestions("/re").map((c) => c.name)).toEqual(["review"]);
    expect(suggestions("/n").map((c) => c.name)).toEqual(["now"]);
    expect(suggestions("/li").map((c) => c.name)).toEqual(["live"]);
    expect(suggestions("/con").map((c) => c.name)).toEqual(["continue", "connectors", "connect"]);
    expect(suggestions("/dis").map((c) => c.name)).toEqual(["disconnect"]);
    expect(suggestions("/").length).toBeGreaterThan(8);
    expect(suggestions("/review ")).toEqual([]);
    expect(suggestions("fix the bug")).toEqual([]);
  });

  it("formats installed connectors by kind", () => {
    const text = connectorLines([
      { id: "codex", name: "Codex", kind: "terminal", installed: true, signedIn: true, capability: "start", connected: true, connect: { scope: "user", file: "~/.codex/config.toml" } },
      { id: "claude-app", name: "Claude app", kind: "app", installed: true, signedIn: false, capability: "review", connected: false, connect: { scope: "user", file: "claude_desktop_config.json" }, hint: "claude auth login" },
      { id: "chatgpt-app", name: "ChatGPT app", kind: "app", installed: false, capability: "none", connected: false, connect: null },
      { id: "zed", name: "Zed", kind: "ide", installed: true, capability: "pickup", connected: false, connect: { manual: "Add a custom MCP server" } },
    ], 120).map(plain).join("\n");
    expect(text).toContain("Terminal agents");
    expect(text).toContain("● codex");
    expect(text).toContain("connected · can start tasks · user config ~/.codex/config.toml");
    expect(text).toContain("Desktop apps");
    expect(text).toContain("not signed in: claude auth login · plans & reviews");
    expect(text).toContain("IDEs");
    expect(text).toContain("Add a custom MCP server");
    expect(text).not.toContain("ChatGPT app");
  });

  it("shows the welcome box with the worker and who decides", () => {
    const text = welcomeBox(80, { root: "/tmp/x", worker: "Copilot (VS Code)", decides: "lead Claude Code", running: 1, review: 2 }).map(plain).join("\n");
    expect(text).toContain("AgentBrain");
    expect(text).not.toContain("╭");
    expect(text).toContain("Copilot (VS Code)");
    expect(text).toContain("2 to review");
  });

  it("groups an agent's events under one header and announces results ready for review", () => {
    const feed = new FeedFormatter(() => "Add a login page");
    const at = "2026-10-09T07:00:00Z";
    const lines = [
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "edit", text: "Edited src/login.tsx" }),
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "command", text: "$ npm test" }),
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "tool", text: "Read src/a.ts" }),
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "status", text: "running → review: Add a login page" }),
    ].map(plain);
    expect(lines.filter((l) => l.startsWith("Copilot (VS Code)"))).toHaveLength(1);
    expect(lines).toContain("    + Edited src/login.tsx");
    expect(lines).toContain("    $ npm test");
    expect(lines.join("\n")).not.toContain("Read src/a.ts");
    expect(lines.join("\n")).toContain("Ready for review · Add a login page");
  });
});

describe("delegation", { timeout: 90_000 }, () => {
  it("turns a prompt into a task in its own worktree and has a headless agent do it", async () => {
    const repo = tempRepo("agentbrain-delegate-");
    initStore(repo);
    const bin = `${repo}-bin`;
    stubAgent(bin, "agentbrain", `exec node ${JSON.stringify(CLI)} "$@"`);
    // A stand-in for `gemini --experimental-acp`.
    stubAgent(bin, "gemini", `exec node ${JSON.stringify(FAKE)}`);
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    try {
      expect(listWorkers().find((w) => w.id === "gemini")?.available).toBe(true);
      const { task, worker } = delegate(repo, { prompt: "Add the feature constant", worker: "gemini" }, { command: "node", args: [CLI] });
      expect(worker.how).toBe("headless");
      expect(task.worktree).toBeDefined();

      let status = "";
      for (let i = 0; i < 240 && status !== "review"; i++) {
        await new Promise((r) => setTimeout(r, 250));
        status = getTask(repo, task.id).status;
      }
      expect(status).toBe("review");
      const done = getTask(repo, task.id);
      expect(fs.readFileSync(path.join(done.worktree!.path, "feature.ts"), "utf8")).toBe("export const feature = 1;\n");
      expect(fs.readFileSync(path.join(repo, ".agentbrain/activity.jsonl"), "utf8")).toContain("Delegated to Gemini CLI");
    } finally {
      process.env.PATH = before;
    }
  });

  it("explains how to get a worker when none is installed", () => {
    const repo = tempRepo("agentbrain-delegate-");
    initStore(repo);
    expect(() => delegate(repo, { prompt: "x", worker: "no-such-agent" }, { command: "node", args: [CLI] })).toThrow(/can.t take work/);
  });
});

describe("choosing an agent per task", { timeout: 90_000 }, () => {
  it("reads @mentions as an explicit choice", async () => {
    const { parseMention } = await import("../src/core/delegate.js");
    expect(parseMention("@codex fix the login bug")).toEqual({ worker: "codex", prompt: "fix the login bug" });
    expect(parseMention("@claude add tests")).toEqual({ worker: "claude-code", prompt: "add tests" });
    expect(parseMention("email @codex later")).toEqual({ prompt: "email @codex later" });
  });

  it("ranks ready agents by who is free and whose work was approved here, with reasons", async () => {
    const { rankWorkers } = await import("../src/core/delegate.js");
    const { createTask, updateTask } = await import("../src/core/actions.js");
    const { saveTask } = await import("../src/core/store.js");
    const repo = tempRepo("agentbrain-rank-");
    initStore(repo);
    const bin = `${repo}-bin`;
    stubAgent(bin, "gemini", "exit 0");
    stubAgent(bin, "claude-code-acp", "exit 0");
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    try {
      // Gemini's last result was sent back; it is also busy right now.
      const done = createTask(repo, "Earlier work");
      saveTask(repo, { ...getTask(repo, done.id), status: "done", reviews: [{ verdict: "changes", reviewer: "developer", worker: "gemini", at: new Date().toISOString() }] });
      const busy = createTask(repo, "Busy work");
      updateTask(repo, busy.id, { status: "running", agent: { id: "gemini", sessionId: "g1" } });
      const ranked = rankWorkers(repo).filter((c) => c.worker.available);
      const ids = ranked.map((c) => c.worker.id);
      expect(ids.indexOf("claude-code")).toBeLessThan(ids.indexOf("gemini"));
      const gemini = ranked.find((c) => c.worker.id === "gemini")!;
      expect(gemini.reasons.join(" ")).toMatch(/busy with 1 task/);
      expect(gemini.reasons.join(" ")).toMatch(/0 approved, 1 sent back/);
      // The "next agent you open" option is always there, as a fallback.
      expect(ids.at(-1)).toBe("any");
    } finally {
      process.env.PATH = before;
    }
  });

  it("can leave a task for whichever agent is opened next, visible to it over MCP", async () => {
    const repo = tempRepo("agentbrain-pull-");
    initStore(repo);
    const { task, worker } = delegate(repo, { prompt: "@any Write the changelog" }, { command: "node", args: [CLI] });
    expect(worker.how).toBe("pull");
    expect(task.objective).toBe("Write the changelog");
    const { AgentBrainMcpServer } = await import("../src/mcp/server.js");
    const server = new AgentBrainMcpServer({ root: repo, output: { write: () => true } as any });
    expect(server.instructions()).toContain(`${task.id}: Write the changelog`);
  });

  it("turns Claude Code and Codex JSON output into feed lines", async () => {
    const { describeOutput } = await import("../src/core/printrun.js");
    const claude = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/w/src/a.ts" } }] } });
    expect(describeOutput("claude-code", claude, "/w")).toMatchObject({ kind: "edit", text: "Edited src/a.ts" });
    const codexCmd = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test" } });
    expect(describeOutput("codex", codexCmd, "/w")).toMatchObject({ kind: "command", text: "$ npm test" });
    const codexEdit = JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "/w/b.ts" }] } });
    expect(describeOutput("codex", codexEdit, "/w")).toMatchObject({ kind: "edit", files: ["b.ts"] });
    expect(describeOutput("codex", "not json", "/w")).toBeNull();
  });

  it("runs Claude Code with no window: streams its edits and sends finished work to review", async () => {
    const { runPrint } = await import("../src/core/printrun.js");
    const { createTask } = await import("../src/core/actions.js");
    const { readActivity } = await import("../src/core/activity.js");
    const repo = tempRepo("agentbrain-print-");
    initStore(repo);
    const task = createTask(repo, "Add the feature constant");
    // A stand-in for `claude -p ... --output-format stream-json`: edits a file, reports it, exits 0.
    const fake = `${repo}-claude`;
    fs.writeFileSync(fake, `#!/usr/bin/env bash
echo 'export const feature = 1;' > feature.ts
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"'"$PWD"'/feature.ts"}}]}}'
echo '{"type":"result","subtype":"success","result":"Added it"}'
`);
    fs.chmodSync(fake, 0o755);
    const result = await runPrint(repo, task.id, { id: "claude-code", command: fake }, { cli: { command: "node", args: [CLI] } });
    expect(result.status).toBe("review");
    const t = getTask(repo, task.id);
    expect(fs.readFileSync(path.join(t.worktree!.path, "feature.ts"), "utf8")).toContain("feature");
    const texts = readActivity(repo).filter((e) => e.agent === "claude-code").map((e) => e.text);
    expect(texts).toContain("Wrote feature.ts");
  });
});

describe("planning", { timeout: 90_000 }, () => {
  it("runs the planner read-only in the main checkout, with the plan instructions and no worktree", async () => {
    const { runPrint } = await import("../src/core/printrun.js");
    const { createTask } = await import("../src/core/actions.js");
    const repo = tempRepo("agentbrain-plan-");
    initStore(repo);
    const task = createTask(repo, "Add OAuth login");
    // A stand-in planner that records the arguments and prompt it was given.
    const fake = `${repo}-planner`;
    const record = `${repo}-planner.txt`;
    fs.writeFileSync(fake, `#!/usr/bin/env bash\necho "ARGS $*" > ${JSON.stringify(record)}\necho "CWD $PWD" >> ${JSON.stringify(record)}\ncat >> ${JSON.stringify(record)}\n`);
    fs.chmodSync(fake, 0o755);
    await runPrint(repo, task.id, { id: "claude-code", command: fake }, { cli: { command: "node", args: [CLI] }, plan: true });
    const seen = fs.readFileSync(record, "utf8");
    expect(seen).toMatch(/--allowedTools mcp__agentbrain Read Grep Glob LS/);
    expect(seen).not.toMatch(/acceptEdits/);
    expect(seen).toContain(`CWD ${fs.realpathSync(repo)}`);
    expect(seen).toContain("Your job: plan and delegate");
    expect(seen).toContain(`parent_task_id "${task.id}"`);
    expect(getTask(repo, task.id).worktree).toBeUndefined();
  });
});

describe("autopilot and usage limits", { timeout: 90_000 }, () => {
  it("treats an agent that hit its usage or session limit as unavailable, with when it resets", async () => {
    const { rankWorkers } = await import("../src/core/delegate.js");
    const { saveSession } = await import("../src/core/store.js");
    const repo = tempRepo("agentbrain-limit-");
    initStore(repo);
    const bin = `${repo}-bin`;
    stubAgent(bin, "gemini", "exit 0");
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    try {
      saveSession(repo, { schemaVersion: "0.1", agentId: "gemini", sessionId: "g1", taskId: "t", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), stopReason: "gemini run ended: exited with code 1: You've hit your session limit · resets 12am (Asia/Calcutta)" });
      const gemini = rankWorkers(repo).find((c) => c.worker.id === "gemini")!;
      expect(gemini.worker.available).toBe(false);
      expect(gemini.worker.note).toMatch(/usage limit; resets 12am/);
    } finally {
      process.env.PATH = before;
    }
  });

  it("never bounces a task back to an agent that already stopped on it, and says when nothing is ready", async () => {
    const { autoContinue } = await import("../src/core/delegate.js");
    const { createTask, writeCheckpoint, takeOver } = await import("../src/core/actions.js");
    const { readActivity } = await import("../src/core/activity.js");
    const repo = tempRepo("agentbrain-auto-");
    initStore(repo);
    const task = createTask(repo, "Do the thing");
    takeOver(repo, task.id, { id: "codex", sessionId: "c1" });
    writeCheckpoint(repo, task.id, { agent: { id: "codex", sessionId: "c1" }, reason: "codex run ended: usage limit", status: "handoff" });
    // Only the "next agent you open" option is ready in tests: autopilot must not use it, and must say so.
    expect(autoContinue(repo, task.id, "codex", "usage limit", { command: "node", args: [CLI] })).toBeNull();
    expect(readActivity(repo).at(-1)!.text).toMatch(/no other agent is ready; the task waits/);
  });
});
