import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeTask } from "../src/core/close.js";
import { ab, readJson, tempRepo } from "./helpers.js";

function taskJson(repo: string, id: string) {
  return readJson(path.join(repo, ".agentbrain/tasks", id, "task.json"));
}

function worktreeTask(repo: string, objective: string) {
  ab(repo, ["task", "create", objective, "--worktree"]);
  const id = readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId as string;
  return { id, worktree: taskJson(repo, id).worktree as { path: string; branch: string } };
}

const branchExists = (repo: string, branch: string) =>
  execFileSync("git", ["branch", "--list", branch], { cwd: repo, encoding: "utf8" }).trim() !== "";

describe("closing a task", () => {
  it("removes the task's worktree but keeps its branch and commits", () => {
    const repo = tempRepo("agentbrain-close-");
    ab(repo, ["init"]);
    const { id, worktree } = worktreeTask(repo, "Build login");
    fs.writeFileSync(path.join(worktree.path, "login.ts"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: worktree.path });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "login"], { cwd: worktree.path });

    const task = closeTask(repo, id, "Closed manually: No longer needed");
    expect(task.status).toBe("done");
    expect(task.worktree).toBeUndefined();
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(true);
    expect(execFileSync("git", ["log", "-1", "--format=%s", worktree.branch], { cwd: repo, encoding: "utf8" }).trim()).toBe("login");
    expect(taskJson(repo, id).worktree).toBeUndefined();
  });

  it("keeps a worktree with uncommitted changes and says so in the note", () => {
    const repo = tempRepo("agentbrain-close-");
    ab(repo, ["init"]);
    const { id, worktree } = worktreeTask(repo, "Build logout");
    fs.writeFileSync(path.join(worktree.path, "logout.ts"), "unsaved\n");

    const task = closeTask(repo, id, "Closed manually: Duplicate task");
    expect(task.status).toBe("done");
    expect(task.worktree?.path).toBe(worktree.path);
    expect(fs.readFileSync(path.join(worktree.path, "logout.ts"), "utf8")).toBe("unsaved\n");
    expect(task.completed).toContainEqual(expect.stringMatching(/^Closed manually: Duplicate task \(worktree kept at .*: it has uncommitted changes\)$/));
  });

  it("closes a task without a worktree as before", () => {
    const repo = tempRepo("agentbrain-close-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Plain task"]);
    const id = readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId as string;
    const task = closeTask(repo, id, "Closed manually: Accidental task");
    expect(task).toMatchObject({ status: "done", nextAction: "Closed manually" });
    expect(task.completed).toContain("Closed manually: Accidental task");
  });
});

describe("status", () => {
  it("does not name a done task as active", () => {
    const repo = tempRepo("agentbrain-close-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Short-lived"]);
    const id = readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId as string;
    expect(ab(repo, ["status"]).stdout).toContain(`Active: ${id}`);

    closeTask(repo, id, "Closed manually: No longer needed");
    const out = ab(repo, ["status"]).stdout;
    expect(out).toContain("Active: none");
    expect(out).not.toContain(id);
  });

  it("still names an active task that is not done", () => {
    const repo = tempRepo("agentbrain-close-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Ongoing"]);
    const id = readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId as string;
    ab(repo, ["task", "update", "--next", "Keep going"]);
    expect(ab(repo, ["status"]).stdout).toContain(`Active: ${id}`);
  });
});
