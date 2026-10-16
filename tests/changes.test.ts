import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask } from "../src/core/actions.js";
import { postCommit } from "../src/core/githooks.js";
import { getTask, initStore, saveTask } from "../src/core/store.js";
import { addWorktree, mergeWorktree } from "../src/core/worktree.js";
import { taskChanges } from "../src/ui/model.js";
import { tempRepo } from "./helpers.js";

describe("taskChanges", () => {
  it("shows a task like a pull request: its commits, files with +/- and the diff, plus uncommitted edits", async () => {
    const repo = tempRepo("agentbrain-changes-");
    initStore(repo);
    const task = addWorktree(repo, createTask(repo, "Add a greeting").id);
    const wt = task.worktree!.path;
    fs.writeFileSync(path.join(wt, "hello.ts"), "export const hello = 'hi';\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Add hello"], { cwd: wt });
    fs.writeFileSync(path.join(wt, "hello.ts"), "export const hello = 'hello';\n");

    const changes = await taskChanges(repo, getTask(repo, task.id));
    expect(changes.commits.map((c) => c.subject)).toEqual(["Add hello"]);
    expect(changes.files).toEqual([{ path: "hello.ts", added: 2, removed: 1, status: "added" }]);
    expect(changes.patch).toContain("+export const hello = 'hello';");
    expect(changes.uncommitted).toBe(true);
    expect(changes.summary).toBe("Add hello");
  });

  it("does not show the main checkout diff for tasks without worktrees", async () => {
    const repo = tempRepo("agentbrain-changes-shared-");
    initStore(repo);
    const first = createTask(repo, "First task");
    const second = createTask(repo, "Second task");
    fs.writeFileSync(path.join(repo, "main.ts"), "export const main = true;\n");

    const [firstChanges, secondChanges] = await Promise.all([
      taskChanges(repo, getTask(repo, first.id)),
      taskChanges(repo, getTask(repo, second.id)),
    ]);
    expect(firstChanges.patch).toBe("");
    expect(secondChanges.patch).toBe("");
    expect(firstChanges.uncommitted).toBe(false);
    expect(secondChanges.uncommitted).toBe(false);
  });

  it("keeps committed diffs isolated between task worktrees", async () => {
    const repo = tempRepo("agentbrain-changes-isolated-");
    initStore(repo);
    const first = addWorktree(repo, createTask(repo, "First worktree task").id);
    const second = addWorktree(repo, createTask(repo, "Second worktree task").id);
    const commit = (workdir: string, file: string, text: string) => {
      fs.writeFileSync(path.join(workdir, file), text);
      execFileSync("git", ["add", file], { cwd: workdir });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file], { cwd: workdir });
    };
    commit(first.worktree!.path, "first.ts", "export const first = true;\n");
    commit(second.worktree!.path, "second.ts", "export const second = true;\n");

    const [firstChanges, secondChanges] = await Promise.all([
      taskChanges(repo, getTask(repo, first.id)),
      taskChanges(repo, getTask(repo, second.id)),
    ]);
    expect(firstChanges.patch).toContain("a/first.ts");
    expect(firstChanges.patch).not.toContain("a/second.ts");
    expect(secondChanges.patch).toContain("a/second.ts");
    expect(secondChanges.patch).not.toContain("a/first.ts");
  });

  it("still shows a merged task's changes after its worktree is gone, even without a recorded base", async () => {
    const repo = tempRepo("agentbrain-changes-");
    initStore(repo);
    const task = addWorktree(repo, createTask(repo, "Add a greeting").id);
    const wt = task.worktree!.path;
    fs.writeFileSync(path.join(wt, "hello.ts"), "export const hello = 'hi';\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Add hello"], { cwd: wt });
    mergeWorktree(repo, task.id);
    const merged = getTask(repo, task.id);
    expect(merged.worktree).toBeUndefined();
    expect((await taskChanges(repo, merged)).files.map((f) => f.path)).toEqual(["hello.ts"]);
    // Tasks merged before the base was recorded: found from the merge commit.
    delete merged.merged!.base;
    merged.updatedAt = new Date(Date.now() + 1000).toISOString();
    saveTask(repo, merged);
    const changes = await taskChanges(repo, getTask(repo, task.id));
    expect(changes.commits.map((c) => c.subject)).toEqual(["Add hello"]);
    expect(changes.files.map((f) => f.path)).toEqual(["hello.ts"]);
  });

  it("shows the commits of a task worked on straight on main, even one no agent claimed", async () => {
    const repo = tempRepo("agentbrain-changes-");
    initStore(repo);
    const task = createTask(repo, "Add a farewell");
    fs.writeFileSync(path.join(repo, "unrelated.ts"), "x\n");
    execFileSync("git", ["add", "unrelated.ts"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Before the task"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "bye.ts"), "export const bye = 1;\n");
    execFileSync("git", ["add", "bye.ts"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Add farewell"], { cwd: repo });
    postCommit(repo);
    const t = getTask(repo, task.id);
    expect(t.status).toBe("idle");
    const changes = await taskChanges(repo, t);
    expect(changes.commits.map((c) => c.subject)).toEqual(["Add farewell"]);
    expect(changes.files.map((f) => f.path)).toEqual(["bye.ts"]);
    expect(changes.summary).toBe("Add farewell");
  });
});
