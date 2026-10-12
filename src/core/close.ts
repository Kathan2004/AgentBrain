import fs from "node:fs";
import path from "node:path";
import { updateTask } from "./actions.js";
import { sessionControl } from "./headless.js";
import type { TaskState } from "./state.js";
import { getTask, listSessions, saveTask, sessionAlive } from "./store.js";
import { removeWorktree } from "./worktree.js";

/**
 * Closing a task without merging it. Any agent still working on it (a
 * background run, a review run) is stopped first, and the task's review record
 * goes, so a late update can't reopen it or start a review of work nobody wants.
 * Its worktree folder is removed too (the branch is kept, so nothing is lost),
 * unless it has uncommitted changes: then it stays and the note says why.
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
  if (task.worktree) {
    try {
      removeWorktree(root, taskId);
    } catch (error) {
      const why = /uncommitted changes/.test((error as Error).message) ? "it has uncommitted changes" : (error as Error).message.split("\n")[0];
      note = `${note} (worktree kept at ${task.worktree.path}: ${why})`;
    }
  }
  return updateTask(root, taskId, { status: "done", todo: [note], done: [note], next });
}
