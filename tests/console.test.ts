import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { delegate, listWorkers } from "../src/core/delegate.js";
import { getTask, initStore } from "../src/core/store.js";
import { FeedFormatter, MarkdownStream, connectorLines, inputBox, markdownLines, railLine, suggestions, taskCard, userBubble, welcomeBox } from "../src/ui/console.js";
import { visibleLength } from "../src/ui/tui.js";
import { CLI, stubAgent, tempRepo } from "./helpers.js";

const FAKE = path.resolve("tests/fixtures/fake-acp-agent.mjs");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("console rendering", () => {
  it("draws a rounded prompt box at exactly the terminal width, wrapping long input inside it", () => {
    const empty = inputBox(60, "", 0);
    expect(empty.lines.map(visibleLength)).toEqual([60, 60, 60]);
    expect(plain(empty.lines[0])).toBe(`╭${"─".repeat(58)}╮`);
    expect(plain(empty.lines[1])).toMatch(/^│ Describe a task.* │$/);
    expect(plain(empty.lines[2])).toBe(`╰${"─".repeat(58)}╯`);
    expect([empty.cursorRow, empty.cursorCol]).toEqual([1, 2]);

    const long = "x".repeat(70);
    const box = inputBox(60, long, 70);
    expect(box.lines).toHaveLength(4);
    expect(box.lines.every((l) => visibleLength(l) === 60)).toBe(true);
    expect(plain(box.lines[1])).toBe(`│ ${"x".repeat(56)} │`);
    expect(plain(box.lines[2])).toBe(`│ ${"x".repeat(14).padEnd(56)} │`);
    expect([box.cursorRow, box.cursorCol]).toEqual([2, 2 + (70 - 56)]);
  });

  it("puts the agent and mode pills under the box, with the hint right-aligned when it fits", () => {
    const wide = inputBox(100, "", 0, { agent: "Codex", agentId: "codex", mode: "task" }).lines.map(plain);
    expect(wide).toHaveLength(4);
    expect(wide[3]).toMatch(/^ \[ Codex \] \[ Task · own worktree \] +shift\+tab agent · \/mode · \/ for commands $/);
    expect(wide[3]).toHaveLength(100);
    const chat = inputBox(80, "", 0, { agent: "Auto → Claude Code", agentId: "claude-code", mode: "chat" }).lines.map(plain);
    expect(chat[1]).toContain("Ask anything");
    expect(chat[3]).toContain("[ Auto → Claude Code ] [ Chat · project root ]");
    expect([...chat[3]].length).toBeLessThanOrEqual(80);
    const narrow = inputBox(30, "", 0, { agent: "Copilot (VS Code)", mode: "chat" }).lines;
    expect(narrow.every((l) => visibleLength(l) <= 30)).toBe(true);
    expect(plain(narrow[3]).endsWith("…")).toBe(true);
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

  it("lays out the welcome screen like the web's Tasks home, never wider than the terminal", () => {
    const now = new Date("2026-10-11T12:00:00Z");
    const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    const info = {
      root: "/tmp/shop",
      now,
      agentsActive: 2,
      decides: "Lead: Claude Code",
      checks: ["npm test"],
      tasks: [
        { id: "t1", status: "review", objective: "Add a login page. With tests.", updatedAt: ago(5) },
        { id: "t2", status: "running", objective: "Fix the flaky rescue test", updatedAt: ago(30) },
        { id: "t3", status: "handoff", objective: `Migrate ${"every table ".repeat(20)}`, updatedAt: ago(180) },
        { id: "t4", status: "done", objective: "Document limits", updatedAt: ago(3000), merged: {} },
      ],
      team: [
        { id: "claude-code", name: "Claude Code", up: true, lead: true },
        { id: "vscode", name: "Copilot (VS Code)", up: false },
      ],
    };
    for (const width of [80, 50]) {
      const lines = welcomeBox(width, info);
      expect(lines.every((l) => visibleLength(l) <= width)).toBe(true);
    }
    const lines = welcomeBox(80, info).map(plain);
    expect(lines[0]).toBe(" AgentBrain  shop");
    expect(lines[1]).toBe(" 1 to review · 1 running · 2 agents active · Lead: Claude Code · Checks: npm te…");
    expect(plain(welcomeBox(100, info)[1])).toBe(" 1 to review · 1 running · 2 agents active · Lead: Claude Code · Checks: npm test");
    const at = (title: string) => lines.findIndex((l) => l.startsWith(` ${title}`));
    expect(at("Needs you")).toBeLessThan(at("In progress"));
    expect(at("In progress")).toBeLessThan(at("Recent"));
    expect(lines[at("Needs you") + 1]).toMatch(/^  ● Add a login page\. +5m$/);
    expect(lines[at("Needs you") + 1]).toHaveLength(80);
    const long = lines.find((l) => l.includes("Migrate"))!;
    expect(long).toMatch(/… 3h$/);
    expect(long).toHaveLength(80);
    expect(lines[at("Recent") + 1]).toMatch(/^  ● Document limits +2d$/);
    expect(lines.find((l) => l.startsWith(" Team"))).toBe(" Team  ● Claude Code LEAD  ○ Copilot (VS Code)");

    const empty = welcomeBox(80, { ...info, tasks: [], checks: [], team: [] }).map(plain).join("\n");
    expect(empty).toContain("Nothing to review.");
    expect(empty).not.toContain("Checks:");
    expect(empty).not.toContain("Team");
  });

  it("right-aligns the developer's message in a rounded bubble", () => {
    const bubble = userBubble("fix the login bug", 60).map(plain);
    expect(bubble).toEqual([
      `${" ".repeat(39)}╭───────────────────╮`,
      `${" ".repeat(39)}│ fix the login bug │`,
      `${" ".repeat(39)}╰───────────────────╯`,
    ]);
    const long = userBubble("word ".repeat(40), 60);
    expect(long.length).toBeGreaterThan(3);
    expect(long.every((l) => visibleLength(l) === 60)).toBe(true);
  });

  it("renders light markdown in replies: bold, code spans, fenced blocks in a box, bullets", () => {
    const lines = markdownLines("Use **care** with `fit`:\n- one\n  - nested\n```ts\nconst x = 1;\n```\n# Done", 40);
    const text = lines.map(plain);
    expect(text[0]).toBe("  Use care with fit:");
    expect(lines[0]).toContain("\x1b[1m");
    expect(text[1]).toBe("  • one");
    expect(text[2]).toBe("    • nested");
    expect(text[3]).toBe(`  ╭─ ts ${"─".repeat(31)}╮`);
    expect(text[4]).toBe(`  │ const x = 1;${" ".repeat(23)}│`);
    expect(text[5]).toBe(`  ╰${"─".repeat(36)}╯`);
    expect(text[6]).toBe("  Done");
    expect(lines.slice(3, 6).every((l) => visibleLength(l) === 40)).toBe(true);

    const wrapped = markdownLines(`- ${"word ".repeat(20)}`, 40).map(plain);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every((l) => l.length <= 40)).toBe(true);
    expect(wrapped[1].startsWith("    word")).toBe(true);

    // Streamed replies: an unclosed fence is closed at the end.
    const md = new MarkdownStream(40);
    expect(md.push("```").map(plain)[0].startsWith("  ╭")).toBe(true);
    expect(md.inFence).toBe(true);
    expect(md.end().map(plain)[0].startsWith("  ╰")).toBe(true);
  });

  it("renders a task card with its state label coloured by state", () => {
    const now = new Date("2026-10-11T12:00:00Z");
    const task = { id: "task-1", status: "review", objective: "Add a login page. With tests.", updatedAt: new Date(now.getTime() - 300_000).toISOString() };
    const card = taskCard(task, 80, { agent: "Codex", action: "Decide: /approve task-1", now });
    expect(card.every((l) => visibleLength(l) <= 80)).toBe(true);
    expect(plain(card[0])).toMatch(/^ ● Add a login page\. +review$/);
    expect(visibleLength(card[0])).toBe(80);
    expect(plain(card[1])).toBe("   task-1 · Codex · 5m ago");
    expect(plain(card[2])).toBe("   Decide: /approve task-1");
    const done = taskCard({ ...task, status: "done", merged: {} }, 80, { now });
    expect(plain(done[0])).toMatch(/merged$/);
  });

  it("honours NO_COLOR and uses truecolor only when the terminal says so", () => {
    const saved = { NO_COLOR: process.env.NO_COLOR, COLORTERM: process.env.COLORTERM };
    const task = { id: "t", status: "review", objective: "x" };
    try {
      process.env.COLORTERM = "truecolor";
      delete process.env.NO_COLOR;
      expect(taskCard(task, 80)[0]).toContain("\x1b[38;2;232;184;74m●");
      process.env.COLORTERM = "";
      expect(taskCard(task, 80)[0]).toMatch(/\x1b\[38;5;\d+m●/);
      process.env.NO_COLOR = "1";
      const lines = [...taskCard(task, 80), ...inputBox(60, "", 0, { agent: "Codex", agentId: "codex", mode: "chat" }).lines, ...userBubble("hi", 40)];
      expect(lines.join("\n")).not.toMatch(/\x1b\[(3|2m)/);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("shows feed events as rail lines with the task title when it fits, and announces results ready for review", () => {
    const feed = new FeedFormatter(() => "Add a login page. With tests.", () => 80);
    const at = "2026-10-09T07:00:00Z";
    const lines = [
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "edit", text: "Edited src/login.tsx" }),
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "command", text: "$ npm test" }),
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "tool", text: "Read src/a.ts" }),
      ...feed.format({ at, agent: "vscode", task: "t1", kind: "status", text: "running → review: Add a login page" }),
    ].map(plain);
    expect(lines[0]).toBe("");
    expect(lines[1]).toMatch(/^● Copilot \(VS Code\) \d\d:\d\d  \+ Edited src\/login\.tsx · Add a login page\.$/);
    expect(lines[2]).toMatch(/^● Copilot \(VS Code\) \d\d:\d\d  \$ npm test · Add a login page\.$/);
    expect(lines.join("\n")).not.toContain("Read src/a.ts");
    expect(lines.join("\n")).toContain("Ready for review · Add a login page.");
    expect(lines.every((l) => l.length <= 80)).toBe(true);

    // The title is dropped, not wrapped, when the event fills the line.
    const tight = plain(railLine("codex", at, "x".repeat(60), "A title", 70));
    expect(tight).not.toContain("A title");
    expect(tight).toHaveLength(70);
    expect(tight.endsWith("…")).toBe(true);
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
