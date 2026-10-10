import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { recordActivity } from "./activity.js";
import { deliverToChat, rankWorkers } from "./delegate.js";
import { brainDir } from "./paths.js";
import { pendingReviews, reviewPolicy } from "./review.js";
import type { TaskState } from "./state.js";
import { getTask, saveTask } from "./store.js";

/**
 * The stand-in reviewer. With a lead, every result waits for the lead's
 * review, so a lead that did the work itself, ran out of quota, or went quiet
 * would stall everything. Then another agent reviews in its place, the same
 * way (packet, diff, AgentBrain's checks, a verdict with notes), and its vote
 * decides unless the lead votes first.
 */

/** Minutes a result waits for a silent lead before someone stands in. */
export const STAND_IN_AFTER_MINUTES = 15;

/** Why this result needs a stand-in now, or null. */
export function standInReason(root: string, task: TaskState, now = new Date()): string | null {
  const policy = reviewPolicy(root);
  // The lead setting its own work to review opens no review record: treat it as just submitted.
  const review = task.review ?? { worker: task.agent?.id ?? "unknown", requestedAt: task.updatedAt ?? new Date().toISOString(), votes: [] };
  if (policy.mode !== "lead" || task.status !== "review" || review.standIn) return null;
  const lead = policy.reviewers[0];
  if (!lead || (review.votes ?? []).some((v) => v.agent === lead)) return null;
  // AgentBrain's own checks come first: the reviewer should see their results.
  if (policy.checks.length && task.review && !review.verifiedAt) return null;
  if ((review.flags ?? []).some((f) => f.kind === "no-change")) return null;
  if (lead === review.worker) return `the lead (${lead}) did this work itself`;
  const leadWorker = rankWorkers(root, now).find((c) => c.worker.id === lead);
  if (leadWorker && !leadWorker.worker.available && /limit/i.test(leadWorker.worker.note ?? "")) {
    return `the lead (${lead}) ${leadWorker.worker.note}`;
  }
  const since = Date.parse(review.verifiedAt ?? review.requestedAt);
  const waited = (now.getTime() - since) / 60_000;
  if (waited >= STAND_IN_AFTER_MINUTES) return `the lead (${lead}) hasn't reviewed in ${Math.round(waited)} minutes`;
  return null;
}

/** Minutes a stand-in has to vote before the slot goes to someone else. */
export const STAND_IN_TIMEOUT_MINUTES = 30;

/**
 * The best-placed agent to review: not the worker, not the lead, not tried
 * already. A background run first; else a chat (Copilot) that isn't busy.
 */
export function pickStandIn(root: string, task: TaskState, now = new Date()): { id: string; how: "print" | "chat" } | null {
  const lead = reviewPolicy(root).reviewers[0];
  const tried = new Set(task.review?.standInsTried ?? []);
  const worker = task.review?.worker ?? task.agent?.id;
  const ok = (c: ReturnType<typeof rankWorkers>[number]) =>
    c.worker.available && c.worker.id !== worker && c.worker.id !== lead && !tried.has(c.worker.id);
  const ranked = rankWorkers(root, now);
  const print = ranked.find((c) => ok(c) && c.worker.how === "print");
  if (print) return { id: print.worker.id, how: "print" };
  // A chat does one thing at a time: not while it is already reviewing another result.
  const reviewing = new Set(pendingReviews(root).filter((t) => t.id !== task.id).map((t) => t.review?.standIn?.agent).filter(Boolean));
  const chat = ranked.find((c) => ok(c) && c.worker.how === "chat" && !reviewing.has(c.worker.id) && !c.reasons.some((r) => /busy/.test(r)));
  return chat ? { id: chat.worker.id, how: "chat" } : null;
}

/** Appoints a stand-in for this result and starts its review run. */
export function appointStandIn(root: string, taskId: string, self: { command: string; args: string[] }, now = new Date()): string | null {
  const task = getTask(root, taskId);
  const why = standInReason(root, task, now);
  if (!why) return null;
  const pick = pickStandIn(root, task, now);
  if (!pick) {
    task.review ??= { worker: task.agent?.id ?? "unknown", requestedAt: now.toISOString(), votes: [], checks: [], flags: [] };
    if (!task.review.standInWanted) {
      task.review.standInWanted = now.toISOString();
      saveTask(root, task);
      recordActivity(root, { agent: "agentbrain", task: taskId, kind: "review", text: `Needs a stand-in reviewer (${why}), but no other agent can review right now; it waits for the lead or you` });
    }
    return null;
  }
  task.review ??= { worker: task.agent?.id ?? "unknown", requestedAt: now.toISOString(), votes: [], checks: [], flags: [] };
  const agent = pick.id;
  task.review.standIn = { agent, at: now.toISOString(), why };
  task.review!.standInsTried = [...(task.review!.standInsTried ?? []), agent];
  saveTask(root, task);
  if (pick.how !== "chat") recordActivity(root, { agent: "agentbrain", task: taskId, kind: "review", text: `${agent} reviews in the lead's place: ${why}` });
  if (pick.how === "chat") {
    const wt = task.worktree;
    const sent = deliverToChat(root, {
      from: "agentbrain",
      to: agent,
      text: `Please review ${taskId} in place of the lead (${why}). Read its packet with agentbrain_brief (task_id ${taskId}), ` +
        `check the diff yourself${wt ? ` (git -C ${JSON.stringify(wt.path)} diff ${wt.base.slice(0, 12)}...HEAD)` : ""} and run the tests that matter, ` +
        `then call agentbrain_review with task_id ${taskId} and verdict approve, or changes with concrete notes. Don't edit the code or change the task's status.`,
    });
    if (!sent) {
      // Busy or closed: not a failed try, so the chat can be asked again later.
      const back = getTask(root, taskId);
      delete back.review!.standIn;
      back.review!.standInsTried = (back.review!.standInsTried ?? []).filter((a) => a !== agent);
      saveTask(root, back);
      return null;
    }
    recordActivity(root, { agent: "agentbrain", task: taskId, kind: "review", text: `${agent} reviews in the lead's place (asked in its chat): ${why}` });
    return agent;
  }
  spawnReview(root, taskId, agent, self);
  return agent;
}

/**
 * Nobody has to open the lead for it to review: when the lead can run in the
 * background (Claude Code, Codex), AgentBrain starts its review run as soon as
 * a result is in and AgentBrain's own checks have run. Once per submission.
 */
export function askLead(root: string, taskId: string, self: { command: string; args: string[] }, now = new Date()): boolean {
  const task = getTask(root, taskId);
  const policy = reviewPolicy(root);
  const review = task.review;
  const lead = policy.reviewers[0];
  if (policy.mode !== "lead" || !lead || task.status !== "review" || !review || review.leadAsked || review.standIn) return false;
  if (review.worker === lead || (review.votes ?? []).some((v) => v.agent === lead)) return false;
  if (policy.checks.length && !review.verifiedAt) return false;
  // Nothing changed: there is nothing to review; it waits for the developer instead of spending a run.
  if ((review.flags ?? []).some((f) => f.kind === "no-change")) return false;
  const choice = rankWorkers(root, now).find((c) => c.worker.id === lead);
  if (!choice || choice.worker.how !== "print" || !choice.worker.available) return false;
  review.leadAsked = now.toISOString();
  saveTask(root, task);
  recordActivity(root, { agent: "agentbrain", task: taskId, kind: "review", text: `Asked the lead, ${lead}, to review ${review.worker}'s result` });
  spawnReview(root, taskId, lead, self);
  return true;
}

function spawnReview(root: string, taskId: string, agent: string, self: { command: string; args: string[] }): void {
  const log = path.join(brainDir(root), "agents", `review-${taskId}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  spawn(self.command, [...self.args, "run", agent, taskId, "--print", "--review"], { cwd: root, detached: true, stdio: ["ignore", fd, fd] }).unref();
  fs.closeSync(fd);
}

/** Looks over every result waiting for review; run on a timer by the control room. */
export function standInSweep(root: string, self: { command: string; args: string[] }, now = new Date()): string[] {
  const started: string[] = [];
  for (const task of pendingReviews(root)) {
    try {
      // A stand-in that never voted (a crashed run, a chat that ignored it) gives the slot back.
      const standIn = task.review?.standIn;
      if (standIn && now.getTime() - Date.parse(standIn.at) > STAND_IN_TIMEOUT_MINUTES * 60_000) {
        releaseStandIn(root, task.id, standIn.agent, `no verdict after ${STAND_IN_TIMEOUT_MINUTES} minutes`);
      }
      if (askLead(root, task.id, self, now)) {
        started.push(`${task.id}:lead`);
        continue;
      }
      const agent = appointStandIn(root, task.id, self, now);
      if (agent) started.push(`${task.id}:${agent}`);
    } catch { /* one bad task shouldn't stop the others */ }
  }
  return started;
}

/** A stand-in run ended without a verdict: free the slot so another agent (or the lead) can take it. */
export function releaseStandIn(root: string, taskId: string, agent: string, reason: string): void {
  const task = getTask(root, taskId);
  if (task.status !== "review" || task.review?.standIn?.agent !== agent) return;
  if ((task.review.votes ?? []).some((v) => v.agent === agent)) return;
  delete task.review.standIn;
  saveTask(root, task);
  recordActivity(root, { agent: "agentbrain", task: taskId, kind: "review", text: `${agent}'s stand-in review ended without a verdict (${reason})` });
}
