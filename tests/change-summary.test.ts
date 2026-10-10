import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { initStore } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { snapshot } from "../src/ui/model.js";
import { tempRepo } from "./helpers.js";

describe("snapshot change summary", () => {
  it("reports commits, files and +/- lines for a worktree task, PR-style", () => {
    const repo = tempRepo("agentbrain-summary-");
    initStore(repo);
    const task = addWorktree(repo, createTask(repo, "Add a greeting").id);
    const wt = task.worktree!.path;
    fs.writeFileSync(path.join(wt, "hello.ts"), "export const hello = 'hi';\nexport const bye = 'bye';\n");
    fs.writeFileSync(path.join(wt, "README.md"), "greetings\n");
    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Add hello"], { cwd: wt });

    // Idle tasks don't pay for git.
    expect(snapshot(repo).tasks.find((t) => t.id === task.id)?.changes).toBeUndefined();

    updateTask(repo, task.id, { status: "running" });
    const live = snapshot(repo).tasks.find((t) => t.id === task.id)!;
    expect(live.changes).toEqual({ commits: 1, files: 2, added: 3, removed: 1 });
  });
});
