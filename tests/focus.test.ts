import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { setFocus } from "../src/core/focus.js";
import { awaitingVote, computeTally, reviewerNotice, reviewSummary, reviewTask, setLead, settleReviews } from "../src/core/review.js";
import { getTask, initStore, saveTask } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { tempRepo } from "./helpers.js";

/** A result by `worker` in review, changing `file`. */
function submitted(options: { lead?: string; file?: string; worker?: string } = {}) {
  const repo = tempRepo("agentbrain-focus-");
  initStore(repo);
  if (options.lead) setLead(repo, options.lead);
  setFocus(repo, "codex", "security");
  const task = addWorktree(repo, createTask(repo, "Add a login endpoint").id);
  const wt = task.worktree!.path;
  const file = options.file ?? "src/login.ts";
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), "export const login = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "login"], { cwd: wt });
  const worker = options.worker ?? "gemini";
  updateTask(repo, task.id, { status: "review", agent: { id: worker, sessionId: `${worker}-1` } });
  return { repo, id: task.id };
}

describe("focus reviewers", () => {
  it("approval waits for the focus review, then lands", () => {
    const { repo, id } = submitted({ lead: "claude-code" });
    expect(awaitingVote(repo, "codex").map((t) => t.id)).toEqual([id]);
    expect(reviewerNotice(repo, "codex")).toMatch(/security reviewer/);

    reviewTask(repo, id, { verdict: "approved", reviewer: "claude-code" });
    const waiting = getTask(repo, id);
    expect(waiting.status).toBe("review");
    expect(computeTally(repo, waiting).blocked).toMatch(/focus review of codex \(security\)/);
    expect(reviewSummary(repo, waiting)).toContain("Focus reviews: codex (security) still to review");

    reviewTask(repo, id, { verdict: "approved", reviewer: "codex" });
    expect(getTask(repo, id).status).toBe("done");
  });

  it("a focus reviewer's changes send the result back, even before the lead votes", () => {
    const { repo, id } = submitted({ lead: "claude-code" });
    reviewTask(repo, id, { verdict: "changes", reviewer: "codex", notes: "src/login.ts: rate-limit failed logins" });
    const back = getTask(repo, id);
    expect(back.status).toBe("handoff");
    expect(back.remaining).toContain("src/login.ts: rate-limit failed logins");
  });

  it("with paths, only reviews results that touch them", () => {
    const narrow = submitted({ lead: "claude-code", file: "src/ui/button.ts" });
    setFocus(narrow.repo, "codex", "security", ["src/auth/"]);
    expect(awaitingVote(narrow.repo, "codex")).toEqual([]);
    reviewTask(narrow.repo, narrow.id, { verdict: "approved", reviewer: "claude-code" });
    expect(getTask(narrow.repo, narrow.id).status).toBe("done");
  });

  it("a silent focus reviewer stops holding a result up after the wait", () => {
    const { repo, id } = submitted({ lead: "claude-code" });
    reviewTask(repo, id, { verdict: "approved", reviewer: "claude-code" });
    expect(settleReviews(repo)).toEqual([]);
    const task = getTask(repo, id);
    task.review!.verifiedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    saveTask(repo, task);
    expect(settleReviews(repo)).toEqual([id]);
    expect(getTask(repo, id).status).toBe("done");
  });

  it("reviews other agents' work even with no lead or council, but never its own", () => {
    const { repo, id } = submitted();
    expect(getTask(repo, id).status).toBe("review");
    reviewTask(repo, id, { verdict: "approved", reviewer: "codex" });
    expect(getTask(repo, id).status).toBe("done");

    // Its own result: nobody reviews it, as if there were no reviewers at all.
    const own = submitted({ worker: "codex" });
    expect(getTask(own.repo, own.id).review).toBeUndefined();
    expect(awaitingVote(own.repo, "codex")).toEqual([]);
  });

  it("docs-only results still wait for a focus reviewer that covers everything", () => {
    const { repo, id } = submitted({ lead: "claude-code", file: "docs/login.md" });
    expect(getTask(repo, id).status).toBe("review");
    reviewTask(repo, id, { verdict: "approved", reviewer: "codex" });
    expect(getTask(repo, id).status).toBe("done");
  });
});
