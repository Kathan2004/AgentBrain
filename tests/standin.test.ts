import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { awaitingVote, computeTally, reviewerNotice, reviewTask, setLead } from "../src/core/review.js";
import { releaseStandIn, standInReason, standInSweep } from "../src/core/standin.js";
import { getTask, initStore, saveTask } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { tempRepo } from "./helpers.js";

function submitted(lead: string, worker: string) {
  const repo = tempRepo("agentbrain-standin-");
  initStore(repo);
  setLead(repo, lead);
  const task = addWorktree(repo, createTask(repo, "Add a greeting").id);
  fs.writeFileSync(path.join(task.worktree!.path, "greet.ts"), "export const hi = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: task.worktree!.path });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "greet"], { cwd: task.worktree!.path });
  updateTask(repo, task.id, { status: "review", agent: { id: worker, sessionId: `${worker}-1` } });
  return { repo, id: task.id };
}

function appoint(repo: string, id: string, agent: string, why = "test") {
  const task = getTask(repo, id);
  task.review!.standIn = { agent, at: new Date().toISOString(), why };
  saveTask(repo, task);
}

describe("stand-in reviewer", () => {
  it("is needed when the lead did the work itself, or stayed silent", () => {
    const own = submitted("claude-code", "vscode");
    expect(standInReason(own.repo, getTask(own.repo, own.id))).toBeNull();
    const later = new Date(Date.now() + 20 * 60_000);
    expect(standInReason(own.repo, getTask(own.repo, own.id), later)).toMatch(/hasn't reviewed in 20 minutes/);

    // The lead set its own work to review: nobody else could ever review it.
    const self = submitted("codex", "codex");
    const task = getTask(self.repo, self.id);
    expect(task.status).toBe("review");
    expect(standInReason(self.repo, task)).toMatch(/did this work itself/);
  });

  it("decides in the lead's place: its vote counts as a review, not an override", () => {
    const { repo, id } = submitted("codex", "vscode");
    appoint(repo, id, "claude-code", "the lead is out of quota");
    expect(awaitingVote(repo, "claude-code").map((t) => t.id)).toEqual([id]);
    expect(reviewerNotice(repo, "claude-code")).toMatch(/standing in for the lead \(codex\)/);
    expect(computeTally(repo, getTask(repo, id)).eligible).toEqual(["claude-code"]);
    const result = reviewTask(repo, id, { verdict: "approved", reviewer: "claude-code" });
    expect(result.outcome).toBe("approved");
    expect(getTask(repo, id).status).toBe("done");
    expect(getTask(repo, id).reviews?.at(-1)?.reviewer).not.toMatch(/override/);
  });

  it("gives way when the lead votes after all", () => {
    const { repo, id } = submitted("codex", "vscode");
    appoint(repo, id, "claude-code");
    const result = reviewTask(repo, id, { verdict: "changes", reviewer: "codex", notes: "Add a test" });
    expect(result.outcome).toBe("changes");
    expect(getTask(repo, id).status).toBe("handoff");
  });

  it("frees the slot when the stand-in ends without a verdict, and doesn't ask the same agent twice", () => {
    const { repo, id } = submitted("codex", "vscode");
    appoint(repo, id, "claude-code");
    const task = getTask(repo, id);
    task.review!.standInsTried = ["claude-code"];
    saveTask(repo, task);
    releaseStandIn(repo, id, "claude-code", "usage limit");
    const after = getTask(repo, id);
    expect(after.review?.standIn).toBeUndefined();
    expect(after.review?.standInsTried).toEqual(["claude-code"]);
    expect(awaitingVote(repo, "claude-code")).toEqual([]);
  });
});

describe("stand-in timeout", () => {
  it("takes the slot back from a stand-in that hasn't voted in 30 minutes", () => {
    const { repo, id } = submitted("codex", "vscode");
    appoint(repo, id, "claude-code");
    standInSweep(repo, { command: "true", args: [] }, new Date(Date.now() + 31 * 60_000));
    expect(getTask(repo, id).review?.standIn).toBeUndefined();
  });
});

describe("usage limits with a reset date", () => {
  it("keeps an agent out until the date its limit names, not just the usual window", async () => {
    const { limitResetsAt } = await import("../src/core/delegate.js");
    const hit = new Date("2026-10-10T07:47:45Z");
    expect(limitResetsAt("You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Nov 8th, 2026 9:42 PM.", hit)?.getFullYear()).toBe(2026);
    // Claude Code names a clock time: the next one after the limit was hit, in its time zone.
    expect(limitResetsAt("You've hit your session limit · resets 12am (Asia/Calcutta)", hit)?.toISOString()).toBe("2026-10-10T18:30:00.000Z");
    expect(limitResetsAt("You've hit your session limit · resets 2:50am (Asia/Calcutta)", new Date("2026-10-16T18:56:00Z"))?.toISOString()).toBe("2026-10-16T21:20:00.000Z");
    expect(limitResetsAt("resets 9pm (UTC)", new Date("2026-10-10T22:00:00Z"))?.toISOString()).toBe("2026-10-11T21:00:00.000Z");
    expect(limitResetsAt("try again at Jan 1st, 2020 1:00 AM", hit)).toBeNull();
  });
});

describe("chat stand-ins", () => {
  it("asks a chat for one review at a time", async () => {
    const { pickStandIn } = await import("../src/core/standin.js");
    const a = submitted("claude-code", "claude-code");
    // A second result in the same project, already being reviewed by the chat.
    const other = addWorktree(a.repo, createTask(a.repo, "Another").id);
    updateTask(a.repo, other.id, { status: "review", agent: { id: "codex", sessionId: "c-1" } });
    appoint(a.repo, other.id, "vscode");
    const pick = pickStandIn(a.repo, getTask(a.repo, a.id));
    expect(pick?.id).not.toBe("vscode");
  });
});

describe("approved but out of date", () => {
  it("sends a result that conflicts with main back to be merged, instead of leaving it in review", () => {
    const { repo, id } = submitted("codex", "vscode");
    fs.writeFileSync(path.join(repo, "greet.ts"), "export const hi = 2;\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main greet"], { cwd: repo });
    reviewTask(repo, id, { verdict: "approved", reviewer: "codex" });
    const task = getTask(repo, id);
    expect(task.status).toBe("handoff");
    expect(task.remaining[0]).toContain("greet.ts");
    expect(task.review).toBeUndefined();
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).not.toMatch(/^UU/m);
  });
});

describe("results that changed nothing", () => {
  it("don't get a background reviewer: there's nothing to review", async () => {
    const { askLead } = await import("../src/core/standin.js");
    const { repo, id } = submitted("claude-code", "ollama");
    const task = getTask(repo, id);
    task.review!.flags = [{ agent: "ollama", kind: "no-change", text: "nothing changed", at: new Date().toISOString() }];
    saveTask(repo, task);
    expect(askLead(repo, id, { command: "true", args: [] })).toBe(false);
    expect(standInReason(repo, getTask(repo, id), new Date(Date.now() + 60 * 60_000))).toBeNull();
  });
});

describe("approved while the main checkout is busy", () => {
  it("keeps the approval and merges once the overlapping change is committed", async () => {
    const { retryPendingMerges } = await import("../src/core/review.js");
    const { repo, id } = submitted("codex", "vscode");
    // The developer is editing the same file in the main checkout, uncommitted.
    // (Main gets the same file the branch adds, so the merge itself is clean.)
    fs.writeFileSync(path.join(repo, "greet.ts"), "export const hi = 1;\n");
    execFileSync("git", ["add", "greet.ts"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base greet"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "greet.ts"), "export const hi = 9;\n");
    const result = reviewTask(repo, id, { verdict: "approved", reviewer: "codex" });
    expect(result.pendingMerge).toMatch(/greet\.ts/);
    expect(getTask(repo, id).status).toBe("review");
    expect(getTask(repo, id).review?.pendingMerge?.by).toBeTruthy();
    expect(awaitingVote(repo, "codex")).toEqual([]);
    // Still busy: nothing happens.
    expect(retryPendingMerges(repo)).toEqual([]);
    // The developer throws the edit away; the approved result merges by itself.
    execFileSync("git", ["checkout", "--", "greet.ts"], { cwd: repo });
    expect(retryPendingMerges(repo)).toEqual([id]);
    expect(getTask(repo, id).status).toBe("done");
  });
});
