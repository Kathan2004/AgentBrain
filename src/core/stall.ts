import fs from "node:fs";
import path from "node:path";
import { latestCheckpoint } from "./actions.js";
import { getGitState } from "./git.js";
import type { AgentRef, TaskState } from "./state.js";
import { taskWorkdir } from "./worktree.js";

export const DEFAULT_STALL_MINUTES = 10;

export interface TaskActivity {
  owner?: AgentRef;
  /** Last time the task's AgentBrain state changed (update, checkpoint, handoff). */
  lastRecorded: Date;
  /** Last time a changed file in the working tree was modified, if any. */
  lastFileChange: Date | null;
  minutesSinceRecorded: number;
  minutesSinceAnyActivity: number;
  /** Nothing has happened at all for the threshold: the agent likely stopped or is waiting on a prompt. */
  stalled: boolean;
  /** Files keep changing but AgentBrain hasn't heard about it for the threshold. */
  unrecorded: boolean;
  /** The task was handed off, files have changed since, and no agent has taken it over. */
  unclaimed: boolean;
}

const minutes = (from: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));

/**
 * Is the agent that owns a running task still making progress? Uses AgentBrain
 * state plus modification times of uncommitted files, since agents often keep
 * working (or get stuck) without reporting. Returns null for tasks that aren't
 * running.
 */
export function taskActivity(
  root: string,
  task: TaskState,
  thresholdMinutes = DEFAULT_STALL_MINUTES,
  now = new Date(),
): TaskActivity | null {
  if (task.status !== "running" && task.status !== "handoff") return null;

  const recorded = [task.updatedAt, latestCheckpoint(root, task.id)?.timestamp]
    .filter((t): t is string => Boolean(t))
    .map((t) => new Date(t).getTime());
  const lastRecorded = new Date(Math.max(...recorded, 0));

  // Per-task: a task with its own worktree only sees its own agent's edits.
  const workdir = taskWorkdir(root, task);
  let latestFile = 0;
  for (const file of getGitState(workdir).changedFiles) {
    try {
      latestFile = Math.max(latestFile, fs.statSync(path.join(workdir, file)).mtimeMs);
    } catch {
      // deleted files have no mtime
    }
  }
  const lastFileChange = latestFile ? new Date(latestFile) : null;
  const lastAny = new Date(Math.max(lastRecorded.getTime(), latestFile));

  const minutesSinceRecorded = minutes(lastRecorded, now);
  const minutesSinceAnyActivity = minutes(lastAny, now);
  if (task.status === "handoff") {
    // Nobody owns it, so it can't stall; but someone working on it unclaimed is worth knowing.
    const unclaimed = lastFileChange !== null && lastFileChange.getTime() > lastRecorded.getTime();
    return {
      owner: task.agent,
      lastRecorded,
      lastFileChange,
      minutesSinceRecorded,
      minutesSinceAnyActivity,
      stalled: false,
      unrecorded: false,
      unclaimed,
    };
  }
  const stalled = minutesSinceAnyActivity >= thresholdMinutes;
  const unrecorded =
    !stalled && lastFileChange !== null && minutes(lastRecorded, lastFileChange) >= thresholdMinutes;

  return {
    owner: task.agent,
    lastRecorded,
    lastFileChange,
    minutesSinceRecorded,
    minutesSinceAnyActivity,
    stalled,
    unrecorded,
    unclaimed: false,
  };
}

/** One-line warning for humans and agents, or null when all is well. */
export function describeActivity(activity: TaskActivity | null): string | null {
  if (!activity) return null;
  const who = activity.owner?.id ?? "the agent";
  if (activity.stalled) {
    return (
      `${who} has shown no activity for ${activity.minutesSinceAnyActivity} min ` +
      "(no AgentBrain updates, no file changes). It may have stopped or be waiting on an approval prompt."
    );
  }
  if (activity.unrecorded) {
    return (
      `${who} is changing files but hasn't recorded progress in AgentBrain for ` +
      `${activity.minutesSinceRecorded} min; if it stops now, that work won't be in the brief.`
    );
  }
  if (activity.unclaimed) {
    return (
      `files have changed since this task was handed off ${activity.minutesSinceRecorded} min ago, ` +
      "but no agent has taken it over in AgentBrain, so that work isn't being tracked."
    );
  }
  return null;
}
