import fs from "node:fs";
import path from "node:path";
import { updateTask } from "./actions.js";
import { sessionControl } from "./headless.js";
import type { TaskState } from "./state.js";
import { getTask, listSessions, saveTask, sessionAlive } from "./store.js";

/**
 * Closing a task without merging it. Any agent still working on it (a
 * background run, a review run) is stopped first, and the task's review record
 * goes, so a late update can't reopen it or start a review of work nobody wants.
 */

export const CLOSE_REASONS = ["Accidental task", "Duplicate task", "No longer needed", "Already handled"];

export function isClosed(task: TaskState): boolean {
  return task.status === "done" && /^Closed/.test(task.nextAction ?? "");
}

export function closeTask(root: string, taskId: string, note: string, next = "Closed manually"): TaskState {
  for (const session of listSessions(root)) {
    if (session.taskId !== taskId && !session.taskIds?.includes(taskId)) continue;
    if (!sessionAlive(session)) continue;
    // Background and review runs watch this file and stop within a second.
    const stop = sessionControl(root, session.agentId, session.sessionId).stop;
    fs.mkdirSync(path.dirname(stop), { recursive: true });
    fs.writeFileSync(stop, note);
  }
  const task = getTask(root, taskId);
  if (task.review) {
    delete task.review;
    saveTask(root, task);
  }
  return updateTask(root, taskId, { status: "done", todo: [note], done: [note], next });
}
