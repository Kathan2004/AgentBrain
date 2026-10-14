import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bringUpToDate, changedFiles, landChanges, recordChangeset, startingPoint } from "./changeset.js";
import { worktreesDir } from "./paths.js";
import type { TaskState } from "./state.js";
import { applyToWorkdir } from "./permissions.js";
import { getTask, listTasks, saveTask } from "./store.js";
import { gitBinary } from "./platform.js";

/**
 * One Git worktree per task, so agents working on different tasks at the same
 * time never edit the same checkout. Worktrees live in
 * `.agentbrain/worktrees/<task-id>` on branch `agentbrain/<task-id>` and share
 * the main checkout's AgentBrain state.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Where a task's code lives: its worktree, or the main checkout. */
export function taskWorkdir(root: string, task: TaskState): string {
  return task.worktree && fs.existsSync(task.worktree.path) ? task.worktree.path : root;
}

/** The task whose worktree contains `dir`, if any. */
export function taskForDir(root: string, dir: string): TaskState | null {
  const resolved = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
  for (const task of listTasks(root)) {
    if (!task.worktree) continue;
    const wt = fs.existsSync(task.worktree.path) ? fs.realpathSync(task.worktree.path) : task.worktree.path;
    if (resolved === wt || resolved.startsWith(wt + path.sep)) return task;
  }
  return null;
}

export function addWorktree(root: string, taskId: string, base = "HEAD"): TaskState {
  const task = getTask(root, taskId);
  if (task.worktree && fs.existsSync(task.worktree.path)) return task;
  try {
    git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error("Worktrees need at least one commit. Commit something first.");
  }

  const dir = worktreesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // Keep worktrees out of the main checkout's `git status`, even if .agentbrain/ is committed.
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");

  const wtPath = path.join(dir, task.id);
  const branch = `agentbrain/${task.id}`;
  const baseCommit = git(root, ["rev-parse", base]);
  const branchExists = (() => {
    try {
      git(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  })();
  git(root, branchExists ? ["worktree", "add", wtPath, branch] : ["worktree", "add", "-b", branch, wtPath, baseCommit]);

  task.worktree = { path: wtPath, branch, base: baseCommit };
  saveTask(root, task);
  // Copilot opened on this folder shouldn't ask for approval when the developer said not to.
  applyToWorkdir(root, wtPath);
  return task;
}

export interface RemoveResult {
  task: TaskState;
  /** Commits on the task branch not yet in the main checkout's HEAD. */
  unmerged: number;
}

/**
 * Removes the task's worktree (the branch is kept). Refuses when the worktree
 * has uncommitted changes, unless `force`.
 */
export function removeWorktree(root: string, taskId: string, force = false): RemoveResult {
  const task = getTask(root, taskId);
  if (!task.worktree) throw new Error(`${task.id} has no worktree.`);
  const { path: wtPath, branch } = task.worktree;
  if (fs.existsSync(wtPath)) {
    const dirty = git(wtPath, ["status", "--porcelain"]);
    if (dirty && !force) {
      throw new Error(`${wtPath} has uncommitted changes. Commit them, or pass --force to discard them.`);
    }
    git(root, ["worktree", "remove", ...(force ? ["--force"] : []), wtPath]);
  }
  let unmerged = 0;
  try {
    unmerged = Number(git(root, ["rev-list", "--count", `HEAD..${branch}`]));
  } catch {
    // branch gone
  }
  delete task.worktree;
  saveTask(root, task);
  return { task, unmerged };
}

export interface MergeResult {
  task: TaskState;
  merged: number;
  conflicts: string[];
  /** Files left out of the result (links out of the repository). */
  skipped?: string[];
}

/**
 * Lands the task's result on the main checkout's current branch as one commit
 * (see changeset.ts: per file, against where the task started, so history it
 * didn't touch can't conflict), then removes the worktree. On conflict
 * nothing changes, and the conflicting files are returned.
 */
export function mergeWorktree(root: string, taskId: string): MergeResult {
  const task = getTask(root, taskId);
  if (!task.worktree) throw new Error(`${task.id} has no worktree.`);
  const { branch, path: wtPath } = task.worktree;

  if (fs.existsSync(wtPath) && git(wtPath, ["status", "--porcelain"])) {
    throw new Error(`${wtPath} has uncommitted changes. Commit them in the worktree first.`);
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  const tip = git(root, ["rev-parse", branch]);
  const base = startingPoint(root, task.worktree.base, tip, head);
  // Someone (the developer, or another agent) may be working in the main checkout at the same
  // time. That's fine unless the task changes the same files: only then stop, and say which.
  const dirty = git(root, ["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  if (dirty.length) {
    const touched = new Set(changedFiles(root, base, tip).files.map((f) => f.path));
    const overlap = dirty.filter((file) => touched.has(file));
    if (overlap.length) {
      throw new Error(`Can't merge yet: ${overlap.join(", ")} ${overlap.length === 1 ? "has" : "have"} uncommitted changes in the main checkout that this task also changes. Commit or stash ${overlap.length === 1 ? "it" : "them"}, then approve again.`);
    }
  }

  const merged = Number(git(root, ["rev-list", "--count", `${base}..${tip}`]));
  const title = task.objective.split("\n")[0];
  const landed = landChanges(root, {
    base,
    tip,
    label: task.id,
    message: `${title.length > 72 ? `${title.slice(0, 71)}…` : title}\n\nLanded from ${branch}.\n\nAgentBrain-Task: ${task.id}\n`,
  });
  if (landed.conflicts.length) return { task, merged, conflicts: landed.conflicts, skipped: landed.skipped.map((s) => s.path) };

  removeWorktree(root, task.id);
  const after = getTask(root, task.id);
  // Remember exactly what landed: the branch's commits never reach main, so Git alone can't tell.
  after.merged = { branch, commit: tip, at: new Date().toISOString(), base, ...(landed.commit ? { landed: landed.commit } : {}), files: landed.files.map((f) => f.path) };
  saveTask(root, after);
  if (landed.commit) {
    recordChangeset(root, {
      id: `cs-${Date.now()}`, task: task.id, ...(task.agent?.id ? { agent: task.agent.id } : {}), base, tip, commit: landed.commit,
      at: after.merged.at, files: landed.files.map((f) => ({ path: f.path, status: f.status })), ...(task.review?.change ? { kind: task.review.change.kind } : {}),
    });
  }
  return { task: after, merged: landed.commit ? merged : 0, conflicts: [], skipped: landed.skipped.map((s) => s.path) };
}

/**
 * Hands a conflicting result back up to date: its worktree gets main's files
 * plus its own, with conflict markers only where they really conflict, and
 * its starting point becomes main. Returns the files to resolve.
 */
export function syncWorktree(root: string, taskId: string): string[] {
  const task = getTask(root, taskId);
  if (!task.worktree) throw new Error(`${task.id} has no worktree.`);
  const head = git(root, ["rev-parse", "HEAD"]);
  const tip = git(root, ["rev-parse", task.worktree.branch]);
  const base = startingPoint(root, task.worktree.base, tip, head);
  const { conflicts } = bringUpToDate(root, task.worktree, base, task.id);
  const after = getTask(root, task.id);
  after.worktree = { ...after.worktree!, base: head };
  saveTask(root, after);
  return conflicts;
}

/**
 * Is everything on `branch` already in HEAD? True when HEAD contains the
 * branch's commits, or, after a squash merge (whose commits never reach HEAD,
 * often followed by more edits to the same lines), when the branch's own
 * changes can be cleanly undone from HEAD, which means they are all there.
 * Anything uncertain counts as not merged.
 */
export function branchMerged(root: string, branch: string): boolean {
  try {
    if (Number(git(root, ["rev-list", "--count", `HEAD..${branch}`])) === 0) return true;
    const base = spawnSync(gitBinary(), ["merge-base", "HEAD", branch], { cwd: root, encoding: "utf8" });
    if (base.status !== 0) return false; // no shared history: can't tell
    const patch = git(root, ["diff", "--binary", base.stdout.trim(), branch]);
    if (!patch) return true;
    // Check against HEAD in a throwaway index, so the working tree is never touched.
    const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-idx-")), "index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      if (spawnSync(gitBinary(), ["read-tree", "HEAD"], { cwd: root, env }).status !== 0) return false;
      const check = spawnSync(gitBinary(), ["apply", "--cached", "--check", "--reverse", "-C1"], { cwd: root, env, input: patch + "\n" });
      return check.status === 0;
    } finally {
      fs.rmSync(path.dirname(index), { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}

export interface PruneWorktreesResult {
  removed: string[];
  deletedBranches: string[];
  skipped: { taskId: string; reason: string }[];
}

/**
 * Cleans up after finished work: removes worktrees of tasks that are done
 * and whose branch is fully merged into the main checkout's HEAD, and with
 * `branches`, deletes merged agentbrain/<id> branches. Never touches a task
 * that isn't done, a branch with unmerged commits, or uncommitted changes.
 */
export function pruneWorktrees(root: string, options: { branches?: boolean; dryRun?: boolean } = {}): PruneWorktreesResult {
  const result: PruneWorktreesResult = { removed: [], deletedBranches: [], skipped: [] };
  if (!options.dryRun) git(root, ["worktree", "prune"]);
  const merged = (branch: string) => branchMerged(root, branch);

  for (const task of listTasks(root)) {
    if (!task.worktree) continue;
    const { branch, path: wtPath } = task.worktree;
    if (task.status !== "done") {
      result.skipped.push({ taskId: task.id, reason: `task is ${task.status}` });
      continue;
    }
    if (!merged(branch)) {
      result.skipped.push({ taskId: task.id, reason: `${branch} has unmerged commits` });
      continue;
    }
    if (fs.existsSync(wtPath) && git(wtPath, ["status", "--porcelain"])) {
      result.skipped.push({ taskId: task.id, reason: "uncommitted changes in its worktree" });
      continue;
    }
    if (!options.dryRun) removeWorktree(root, task.id);
    result.removed.push(task.id);
  }

  if (options.branches) {
    const branches = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/agentbrain/"]).split("\n").filter(Boolean);
    const inUse = new Set(listTasks(root).filter((t) => t.worktree && !result.removed.includes(t.id)).map((t) => t.worktree!.branch));
    // Branches AgentBrain merged itself (and that haven't moved since) are known merged.
    const recorded = new Map(listTasks(root).filter((t) => t.merged).map((t) => [t.merged!.branch, t.merged!.commit]));
    for (const branch of branches) {
      const known = recorded.get(branch) === git(root, ["rev-parse", branch]);
      if (inUse.has(branch) || (!known && !merged(branch))) continue;
      // -D: git's own check misses squash merges; merged() above verified nothing would be lost.
      if (!options.dryRun) git(root, ["branch", "-D", branch]);
      result.deletedBranches.push(branch);
    }
  }
  return result;
}
