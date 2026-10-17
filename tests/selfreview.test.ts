import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { setModels } from "../src/core/models.js";
import { reviewTask, setLead } from "../src/core/review.js";
import { getTask, initStore } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { tempRepo } from "./helpers.js";

function submitted(worker: string) {
  const repo = tempRepo("agentbrain-selfreview-");
  initStore(repo);
  setLead(repo, "claude-code");
  setModels(repo, "claude-code", { lead: "opus", workers: [{ name: "sonnet", model: "sonnet" }] });
  const task = addWorktree(repo, createTask(repo, "Add a parser").id);
  const wt = task.worktree!.path;
  fs.writeFileSync(path.join(wt, "parser.ts"), "export const parse = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "parser"], { cwd: wt });
  updateTask(repo, task.id, { status: "review", agent: { id: worker, sessionId: `${worker}-1` } });
  return { repo, id: task.id };
}

describe("who may decide a result", () => {
  it("a worker can't approve its own result, even as a non-reviewer", () => {
    const { repo, id } = submitted("claude-code.sonnet");
    expect(() => reviewTask(repo, id, { verdict: "approved", reviewer: "claude-code.sonnet" })).toThrow(/your own work/);
    expect(getTask(repo, id).status).toBe("review");
  });

  it("an agent that isn't a reviewer can't decide (only the developer overrides)", () => {
    const { repo, id } = submitted("claude-code.sonnet");
    expect(() => reviewTask(repo, id, { verdict: "approved", reviewer: "codex" })).toThrow(/isn't a reviewer/);
    expect(getTask(repo, id).status).toBe("review");
  });

  it("the lead and the developer still decide", () => {
    const a = submitted("claude-code.sonnet");
    expect(reviewTask(a.repo, a.id, { verdict: "approved", reviewer: "claude-code" }).outcome).toBe("approved");
    const b = submitted("claude-code.sonnet");
    expect(reviewTask(b.repo, b.id, { verdict: "changes", reviewer: "developer", notes: "Name it parseLine" }).outcome).toBe("changes");
  });
});
