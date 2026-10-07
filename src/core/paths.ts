import fs from "node:fs";
import path from "node:path";

export function brainDir(cwd: string): string {
  return path.join(cwd, ".agentbrain");
}

/**
 * Walks up from `start` to the directory holding the project's `.agentbrain/`.
 *
 * Task worktrees live in `.agentbrain/worktrees/<task-id>` and share the main
 * checkout's state, so a `.agentbrain/` found inside a worktree (a stale copy,
 * if the repo commits its state) is skipped in favour of the outer one.
 */
export function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const inWorktree = dir.split(path.sep).join("/").includes("/.agentbrain/worktrees/");
    if (!inWorktree && fs.existsSync(path.join(brainDir(dir), "project.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function worktreesDir(root: string): string {
  return path.join(brainDir(root), "worktrees");
}

/** IDs become path segments, so keep them to a safe character set. */
export function assertSafeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid id "${id}". Use letters, digits, ".", "_" or "-".`);
  }
  return id;
}

export function tasksDir(cwd: string): string {
  return path.join(brainDir(cwd), "tasks");
}

export function taskDir(cwd: string, taskId: string): string {
  return path.join(tasksDir(cwd), assertSafeId(taskId));
}

export function checkpointsDir(cwd: string, taskId: string): string {
  return path.join(taskDir(cwd, taskId), "checkpoints");
}

export function sessionFile(cwd: string, agentId: string, sessionId: string): string {
  return path.join(
    brainDir(cwd),
    "agents",
    assertSafeId(agentId),
    "sessions",
    `${assertSafeId(sessionId)}.json`,
  );
}
