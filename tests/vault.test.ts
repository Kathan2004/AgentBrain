import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeVault } from "../src/core/vault.js";
import { saveSession, saveTask } from "../src/core/store.js";
import { initStore } from "../src/core/store.js";
import type { AgentSessionState, TaskState } from "../src/core/state.js";
import { ab, tempRepo } from "./helpers.js";

describe("Obsidian vault", () => {
  it("generates linked brain, task, and agent notes from state and activity", () => {
    const repo = tempRepo("agentbrain-vault-");
    initStore(repo);
    const task: TaskState = {
      id: "task-1",
      objective: "Build the vault",
      status: "running",
      completed: ["Design notes"],
      remaining: ["Add tests"],
      decisions: ["Use Markdown"],
      failures: [],
      agent: { id: "vscode", sessionId: "s-1" },
    };
    saveTask(repo, task);
    const session: AgentSessionState = {
      schemaVersion: "0.1",
      agentId: "vscode",
      sessionId: "s-1",
      taskId: task.id,
      startedAt: new Date().toISOString(),
    };
    saveSession(repo, session);

    const folder = writeVault(repo);
    const brain = fs.readFileSync(path.join(folder, "Brain.md"), "utf8");
    const taskNote = fs.readFileSync(path.join(folder, "Tasks/task-1.md"), "utf8");
    const agentNote = fs.readFileSync(path.join(folder, "Agents/vscode.md"), "utf8");
    expect(brain).toContain("[[Tasks/task-1]]");
    expect(brain).toContain("[[Agents/vscode]]");
    expect(taskNote).toContain("[[Agents/vscode]]");
    expect(taskNote).toContain("generated: agentbrain");
    expect(agentNote).toContain("[[Tasks/task-1]]");
    expect(ab(repo, ["vault"]).stdout).toContain(folder);
  });

  it("removes stale generated notes but preserves user notes", () => {
    const repo = tempRepo("agentbrain-vault-");
    initStore(repo);
    const folder = path.join(repo, ".agentbrain/vault");
    fs.mkdirSync(path.join(folder, "Tasks"), { recursive: true });
    fs.writeFileSync(path.join(folder, "Tasks/stale.md"), "---\ngenerated: agentbrain\n---\n# Stale\n");
    fs.writeFileSync(path.join(folder, "keep.md"), "# My note\n");

    writeVault(repo);

    expect(fs.existsSync(path.join(folder, "Tasks/stale.md"))).toBe(false);
    expect(fs.readFileSync(path.join(folder, "keep.md"), "utf8")).toBe("# My note\n");
  });

  it("does not rewrite unchanged generated notes", () => {
    const repo = tempRepo("agentbrain-vault-");
    initStore(repo);

    const folder = writeVault(repo);
    const files = ["Brain.md"];
    const before = new Map(files.map((file) => [file, fs.statSync(path.join(folder, file)).mtimeMs]));
    writeVault(repo);

    for (const file of files) expect(fs.statSync(path.join(folder, file)).mtimeMs).toBe(before.get(file));
  });
});
describe("the memory palace", () => {
  it("builds onboarding, lessons, decision and code notes, an Obsidian config, and keeps agents' memories", async () => {
    const { createTask, updateTask } = await import("../src/core/actions.js");
    const { recordActivity } = await import("../src/core/activity.js");
    const { remember, recall, lessonsDigest } = await import("../src/core/vault.js");
    const { getTask } = await import("../src/core/store.js");
    const repo = tempRepo("agentbrain-palace-");
    initStore(repo);
    const task = createTask(repo, "Add token refresh");
    updateTask(repo, task.id, { decisions: ["Rotate refresh tokens on every use"], agent: { id: "codex", sessionId: "x" } });
    recordActivity(repo, { agent: "codex", task: task.id, kind: "edit", text: "Edited src/auth.ts", files: ["src/auth.ts"] });
    saveTask(repo, { ...getTask(repo, task.id), reviews: [{ verdict: "changes", reviewer: "claude-code", worker: "codex", notes: "Never log raw tokens", at: new Date().toISOString() }] });

    const dir = writeVault(repo);
    const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
    expect(read("Onboarding.md")).toContain("[[Lessons]]");
    expect(read("Lessons.md")).toContain("Never log raw tokens");
    expect(read("Lessons.md")).toContain("[[Agents/codex|codex]]");
    const decision = fs.readdirSync(path.join(dir, "Decisions")).find((f) => f.startsWith("rotate-refresh-tokens"))!;
    expect(read(`Decisions/${decision}`)).toContain(`[[Tasks/${task.id}|Add token refresh]]`);
    expect(read("Code/src__auth.ts.md")).toContain(`[[Tasks/${task.id}|Add token refresh]]`);
    expect(read(`Tasks/${task.id}.md`)).toContain("[[Code/src__auth.ts|src/auth.ts]]");
    expect(JSON.parse(read(".obsidian/graph.json")).colorGroups.length).toBeGreaterThan(3);

    const saved = remember(repo, { title: "Auth tokens live in the keychain", text: "Never write tokens to disk; use the keychain helper in src/auth.ts.", author: "claude-code" });
    writeVault(repo);
    expect(read(saved)).toContain("author: claude-code");
    expect(read("Memory/index.md")).toContain("Auth tokens live in the keychain");
    const hits = recall(repo, "tokens keychain");
    expect(hits[0].note).toBe(saved.replace(/\.md$/, ""));
    expect(lessonsDigest(repo)).toContain("Never log raw tokens");
    // Regenerating never touches agents' memories.
    writeVault(repo);
    expect(fs.existsSync(path.join(dir, saved))).toBe(true);
  });
});

describe("the vault as a graph", () => {
  it("reads every note and resolves [[links]] by path or by name, like Obsidian", async () => {
    const { vaultGraph, readNote } = await import("../src/core/vault.js");
    const repo = tempRepo("agentbrain-vgraph-");
    initStore(repo);
    saveTask(repo, { id: "task-1", objective: "Build the vault", status: "running", completed: [], remaining: [], decisions: ["Use Markdown"], failures: [], agent: { id: "vscode", sessionId: "s" } });
    const { dir, nodes } = vaultGraph(repo);
    fs.writeFileSync(path.join(dir, "My idea.md"), "# My idea\nSee [[task-1]] and [[Agents/vscode|Copilot]].\n");
    const graph = vaultGraph(repo);
    const mine = graph.nodes.find((n) => n.id === "My idea")!;
    expect(mine).toMatchObject({ room: "Home", kept: true, title: "My idea" });
    expect(mine.links.sort()).toEqual(["Agents/vscode", "Tasks/task-1"]);
    const task = nodes.find((n) => n.id === "Tasks/task-1")!;
    expect(task.title).toBe("Build the vault");
    expect(task.links).toContain("Agents/vscode");
    expect(readNote(repo, "My idea")).toContain("See [[task-1]]");
    expect(() => readNote(repo, "../project")).toThrow(/Not a note/);
  });
});
