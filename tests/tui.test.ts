import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { recordActivity } from "../src/core/activity.js";
import { setLead } from "../src/core/review.js";
import { getTask, saveTask } from "../src/core/store.js";
import { snapshot } from "../src/ui/model.js";
import { fit, handleKey, initialState, parseInput, renderFrame, visibleLength } from "../src/ui/tui.js";
import { ab, readJson, tempRepo } from "./helpers.js";

const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).join("\n");

function project() {
  const repo = tempRepo("agentbrain-tui-");
  ab(repo, ["init"]);
  ab(repo, ["task", "create", "Build login", "--worktree"]);
  const login = readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId;
  ab(repo, ["task", "update", "--agent", "copilot", "--session", "p1", "--todo", "Write tests", "--decision", "Use JWT", "--next", "Write tests"]);
  ab(repo, ["task", "create", "Add logout"]);
  const wt = readJson(path.join(repo, ".agentbrain/tasks", login, "task.json")).worktree.path;
  fs.writeFileSync(path.join(wt, "README.md"), "demo\nchanged\n");
  return { repo, login };
}

describe("terminal live view", () => {
  it("lists tasks and shows the selected task's brief", () => {
    const { repo } = project();
    const snap = snapshot(repo);
    const frame = renderFrame(repo, snap, initialState(), 140, 40);
    const text = plain(frame.lines);
    expect(frame.lines).toHaveLength(40);
    expect(text).toContain("AgentBrain");
    // Running tasks sort first.
    expect(snap.tasks[0].objective).toBe("Build login");
    expect(text).toContain("copilot");
    expect(text).toContain("Add logout");
    expect(text).toContain("Next");
    expect(text).toContain("1. Build login");
    expect(text).toContain("Use JWT");
    expect(text).toContain("worktree agentbrain/task-");
    for (const line of frame.lines) expect(visibleLength(line)).toBeLessThanOrEqual(140);
  });

  it("prioritizes automated review risks before ordinary reviews", () => {
    const repo = tempRepo("agentbrain-tui-review-priority-");
    ab(repo, ["init"]);
    const older = createTask(repo, "Older review");
    const newer = createTask(repo, "Newer review");
    older.status = "review";
    older.review = { worker: "codex", requestedAt: "2026-01-01T00:00:00.000Z", votes: [], checks: [], flags: [] };
    newer.status = "review";
    newer.review = {
      worker: "codex",
      requestedAt: "2026-01-02T00:00:00.000Z",
      votes: [],
      checks: [],
      flags: [{ agent: "codex", kind: "hallucination", text: "Missing file", at: "2026-01-02T00:00:00.000Z" }],
    };
    saveTask(repo, older);
    saveTask(repo, newer);

    expect(snapshot(repo).tasks.slice(0, 2).map((task) => task.id)).toEqual([newer.id, older.id]);
  });

  it("shows queued objectives and the queue count", () => {
    const { repo } = project();
    const queued = createTask(repo, "Queued report");
    const projectFile = path.join(repo, ".agentbrain/project.json");
    const projectState = readJson(projectFile) as { queue?: string[] };
    projectState.queue = [queued.id, "missing-task"];
    fs.writeFileSync(projectFile, `${JSON.stringify(projectState, null, 2)}\n`);
    const text = plain(renderFrame(repo, snapshot(repo), initialState(), 140, 40).lines);
    expect(text).toContain("queue: 1");
    expect(text).toContain("Queued report");
  });

  it("shows the task's own worktree diff and its timeline", () => {
    const { repo } = project();
    const snap = snapshot(repo);
    const state = initialState();
    handleKey(state, "2", snap.tasks.length);
    const changes = plain(renderFrame(repo, snap, state, 140, 40).lines);
    expect(changes).toContain("README.md");
    expect(changes).toContain("+changed");
    handleKey(state, "4", snap.tasks.length);
    expect(plain(renderFrame(repo, snap, state, 140, 40).lines)).toMatch(/copilot\s+start/);
  });

  it("explains how to watch agents that aren't headless", () => {
    const { repo } = project();
    const state = initialState();
    handleKey(state, "3", 2);
    expect(plain(renderFrame(repo, snapshot(repo), state, 140, 40).lines)).toContain("No headless agent is running on this task");
  });

  it("shows review tasks with checks, flags, and tally", () => {
    const { repo, login } = project();
    setLead(repo, "claude");
    updateTask(repo, login, { status: "done", agent: { id: "codex", sessionId: "c1" } });
    const task = getTask(repo, login);
    task.review!.checks = [
      { command: "npm test", ok: true, exitCode: 0, tail: "", ms: 1200, at: "2026-10-09T10:00:00.000Z" },
      { command: "npm run lint", ok: false, exitCode: 1, tail: "lint failed", ms: 800, at: "2026-10-09T10:01:00.000Z" },
    ];
    task.review!.flags = [{ agent: "agentbrain", kind: "false-claim", text: "Claims checks pass, but lint failed.", at: "2026-10-09T10:01:00.000Z" }];
    task.review!.verifiedAt = "2026-10-09T10:01:00.000Z";
    saveTask(repo, task);

    const state = initialState();
    handleKey(state, "6", 2);
    const frame = renderFrame(repo, snapshot(repo), state, 140, 30);
    const text = plain(frame.lines);
    expect(text).toContain("Review (1)");
    expect(text).toContain(`by codex: ${task.objective}`);
    expect(text).toContain("✓ npm test");
    expect(text).toContain("✗ npm run lint");
    expect(text).toContain("false-claim: Claims checks pass, but lint failed. (agentbrain)");
    expect(text).toContain("tally 0/0 of 1 approve/changes");
    expect(text).toContain("blocked: checks failed: npm run lint");
    for (const line of frame.lines) expect(visibleLength(line)).toBeLessThanOrEqual(140);
  });

  it("shows recent activity newest first", () => {
    const { repo, login } = project();
    recordActivity(repo, { at: "2026-10-09T09:00:00.000Z", agent: "codex", task: login, kind: "edit", text: "Edited src/ui/tui.ts" });
    recordActivity(repo, { at: "2026-10-09T09:01:00.000Z", agent: "agentbrain", task: login, kind: "review", text: "✓ npm test (1s)" });

    const state = initialState();
    handleKey(state, "7", 2);
    const frame = renderFrame(repo, snapshot(repo), state, 100, 30);
    const text = plain(frame.lines);
    expect(text).toContain("Activity");
    expect(text.indexOf("10-09 09:01 agentbrain")).toBeLessThan(text.indexOf("10-09 09:00 codex"));
    expect(text).toContain("✓ ✓ npm test (1s)");
    expect(text).toContain("✎ Edited src/ui/tui.ts");
    for (const line of frame.lines) expect(visibleLength(line)).toBeLessThanOrEqual(100);
  });

  it("maps keys and mouse clicks to state", () => {
    const state = initialState();
    expect(handleKey(state, "j", 2)).toEqual({ type: "none" });
    expect(state.selected).toBe(1);
    handleKey(state, "j", 2);
    expect(state.selected).toBe(1);
    handleKey(state, "\x1b[C", 2);
    expect(state.view).toBe("changes");
    handleKey(state, "7", 2);
    expect(state.view).toBe("activity");
    expect(handleKey(state, "o", 2)).toEqual({ type: "open" });
    handleKey(state, "m", 2);
    for (const ch of "hi there") handleKey(state, ch, 2);
    expect(handleKey(state, "\r", 2)).toEqual({ type: "send", text: "hi there" });
    expect(state.input).toBeNull();
    expect(handleKey(state, "q", 2)).toEqual({ type: "quit" });
    expect(parseInput("j\x1b[<0;5;7M\x1b[Bq")).toEqual(["j", "\x1b[<0;5;7M", "\x1b[B", "q"]);
  });

  it("selects a task by clicking its row", () => {
    const { repo } = project();
    const frame = renderFrame(repo, snapshot(repo), initialState(), 140, 40);
    const rowOfSecond = [...frame.listRows.entries()].find(([, i]) => i === 1)![0];
    expect(plain([frame.lines[rowOfSecond - 1]])).toMatch(/Add logout|idle/);
  });

  it("fits styled text to a width", () => {
    expect(visibleLength(fit("\x1b[1mhello world\x1b[0m", 5))).toBe(5);
    expect(visibleLength(fit("hi", 5))).toBe(5);
  });

  it("stacks the list above the details in narrow terminals", () => {
    const { repo } = project();
    const frame = renderFrame(repo, snapshot(repo), initialState(), 50, 30);
    expect(frame.lines).toHaveLength(30);
    for (const line of frame.lines) expect(visibleLength(line)).toBeLessThanOrEqual(50);
    const text = plain(frame.lines);
    expect(text).toContain("Build login");
    expect(text).toContain("1over");
    expect(text).toContain("7acti");
    // Details get the full width instead of a sliver.
    expect(text).toContain("Use JWT");
  });
});
