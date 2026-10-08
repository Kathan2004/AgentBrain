import { getProject, getTask, saveProject } from "./store.js";
import type { TaskStatus } from "./state.js";

/**
 * A queue of tasks for one agent: `agentbrain queue run` hands the next task
 * over as soon as the current one is finished (review, done), handed off,
 * blocked or failed. Stored in project.json so it survives restarts.
 */

/** Statuses at which a dispatched task no longer needs the agent. */
export const SETTLED: TaskStatus[] = ["review", "done", "handoff", "blocked", "failed"];

export function readQueue(root: string): string[] {
  return getProject(root).queue ?? [];
}

export function addToQueue(root: string, taskIds: string[]): string[] {
  const project = getProject(root);
  for (const id of taskIds) getTask(root, id); // must exist
  const queue = [...(project.queue ?? [])];
  for (const id of taskIds) if (!queue.includes(id)) queue.push(id);
  project.queue = queue;
  saveProject(root, project);
  return queue;
}

export function removeFromQueue(root: string, taskIds: string[]): string[] {
  const project = getProject(root);
  project.queue = (project.queue ?? []).filter((id) => !taskIds.includes(id));
  saveProject(root, project);
  return project.queue;
}

/** Takes the next task off the queue, skipping ones already finished. */
export function shiftQueue(root: string): string | null {
  const project = getProject(root);
  const queue = [...(project.queue ?? [])];
  let next: string | null = null;
  while (queue.length && !next) {
    const id = queue.shift()!;
    if (!["review", "done"].includes(getTask(root, id).status)) next = id;
  }
  project.queue = queue;
  saveProject(root, project);
  return next;
}

/** Resolves when the task reaches a settled status (polling; works across processes). */
export async function waitUntilSettled(root: string, taskId: string, pollMs = 3000, onTick?: () => void): Promise<TaskStatus> {
  // Give the agent a moment to pick the task up before judging its status.
  await new Promise((r) => setTimeout(r, Math.min(pollMs, 1000)));
  for (;;) {
    const status = getTask(root, taskId).status;
    if (SETTLED.includes(status)) return status;
    onTick?.();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
