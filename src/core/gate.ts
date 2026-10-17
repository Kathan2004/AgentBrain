import { execFileSync, spawnSync } from "node:child_process";
import { createTask, updateTask } from "./actions.js";
import { recordActivity } from "./activity.js";
import { startVerification } from "./review.js";
import { gitBinary } from "./platform.js";
import type { TaskState } from "./state.js";
import { getProject, getTask, listTasks, saveProject, saveTask } from "./store.js";
import { addWorktree, removeWorktree, taskWorkdir } from "./worktree.js";

/**
 * Automated changes go through the same gate as agents' work: a bot's branch
 * (Dependabot, Renovate, any ref) or what a codemod or script changed becomes
 * a task in review, with AgentBrain's own checks, the review rules, focus
 * reviewers and the lead or council, and lands per file like any result.
 * The bot is the worker: its record and reputation build up like an agent's.
 */

export const DEFAULT_BOT_BRANCHES = ["dependabot/", "renovate/"];
const WATCH_EVERY_MS = 10 * 60_000;

function git(cwd: string, args: string[]): string {
  return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** A worker id for a bot: "dependabot[bot]" → "dependabot-bot". */
export function botId(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error(`"${name}" can't name a worker.`);
  return id;
}

/** Who made a ref, from its branch name or its author: dependabot/npm/x → dependabot. */
export function guessBot(root: string, ref: string): string {
  const branch = ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, "").replace(/^[^/]+\/(?=(dependabot|renovate)\/)/, "");
  const first = branch.split("/")[0];
  if (DEFAULT_BOT_BRANCHES.some((p) => p === `${first}/`)) return first;
  const author = tryGit(root, ["log", "-1", "--format=%an", ref]);
  return author ? botId(author) : "automation";
}

function submit(root: string, task: TaskState, by: string, done: string[]): TaskState {
  updateTask(root, task.id, { status: "review", agent: { id: by, sessionId: `gate-${Date.now()}` }, done, next: "Review the change" });
  // With no lead or council an agent's finished work isn't reviewed, but automation's always is: open
  // the review, so AgentBrain's checks and the review rules run and it waits for the developer.
  const opened = getTask(root, task.id);
  if (!opened.review) {
    opened.review = { worker: by, requestedAt: new Date().toISOString(), votes: [], checks: [], flags: [] };
    saveTask(root, opened);
    startVerification(root, task.id);
  }
  recordActivity(root, { agent: "agentbrain", task: task.id, kind: "review", text: `${by}'s change is gated like agent work: ${task.objective}` });
  return getTask(root, task.id);
}

/** Gates a branch or commit someone else's automation made. Gating the same commit twice returns the first task. */
export function gateRef(root: string, ref: string, by?: string): TaskState {
  const sha = tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha) throw new Error(`"${ref}" isn't a branch or commit here. Fetch it first (git fetch).`);
  const existing = listTasks(root).find((t) => t.gated?.sha === sha);
  if (existing) return existing;
  const base = tryGit(root, ["merge-base", "HEAD", sha]);
  if (!base) throw new Error(`${ref} shares no history with the current branch.`);
  if (base === sha) throw new Error(`${ref} is already in the current branch: nothing to gate.`);
  const who = botId(by ?? guessBot(root, ref));
  const subjects = git(root, ["log", "--reverse", "--format=%s", `${base}..${sha}`]).split("\n").filter(Boolean);
  const task = createTask(root, `${who}: ${subjects.at(-1) ?? ref}`, { activate: false });
  addWorktree(root, task.id, sha);
  const fresh = getTask(root, task.id);
  fresh.worktree = { ...fresh.worktree!, base };
  fresh.gated = { by: who, ref, sha, at: new Date().toISOString() };
  saveTask(root, fresh);
  return submit(root, fresh, who, subjects.slice(-10));
}

/**
 * Runs a codemod or script in a task's own worktree and gates what it
 * changed. Nothing changed: the task is closed. The command failed: it waits
 * for the developer with the output.
 */
export function gateCommand(root: string, command: string, by = "script", timeoutMinutes = 30): TaskState {
  const who = botId(by);
  const task = addWorktree(root, createTask(root, `${who}: ${command}`, { activate: false }).id);
  const wt = taskWorkdir(root, task);
  const fresh = getTask(root, task.id);
  fresh.gated = { by: who, command, sha: "", at: new Date().toISOString() };
  saveTask(root, fresh);
  const run = spawnSync(command, { cwd: wt, shell: true, encoding: "utf8", timeout: timeoutMinutes * 60_000, maxBuffer: 50_000_000 });
  const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
  if (run.status !== 0) {
    updateTask(root, task.id, { status: "blocked", failures: [`${command} exited with ${run.status ?? run.signal}: ${tail.slice(0, 500)}`], next: "Fix the command, or run it again" });
    return getTask(root, task.id);
  }
  if (!tryGit(wt, ["status", "--porcelain"])) {
    updateTask(root, task.id, { status: "done", decisions: [`${command} changed nothing`], next: "Nothing to review" });
    try { removeWorktree(root, task.id); } catch { /* keep it */ }
    return getTask(root, task.id);
  }
  git(wt, ["add", "-A"]);
  execFileSync(gitBinary(), ["commit", "-q", "-m", `${who}: ${command}`], { cwd: wt, stdio: "ignore" });
  const done = getTask(root, task.id);
  done.gated = { ...done.gated!, sha: git(wt, ["rev-parse", "HEAD"]) };
  saveTask(root, done);
  return submit(root, done, who, [`Ran ${command}`]);
}

/**
 * Fetches and gates every bot branch not gated yet. A branch the bot pushed
 * again replaces its earlier task (closed as superseded).
 */
export function gateIncoming(root: string, options: { remote?: string; match?: string[]; fetch?: boolean } = {}): TaskState[] {
  const remote = options.remote ?? getProject(root).gate?.remote ?? "origin";
  const match = options.match ?? getProject(root).gate?.match ?? DEFAULT_BOT_BRANCHES;
  if (options.fetch !== false) git(root, ["fetch", "--quiet", "--prune", remote]);
  const refs = (tryGit(root, ["for-each-ref", "--format=%(refname:short) %(objectname)", `refs/remotes/${remote}/`]) ?? "")
    .split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]);
  const gated: TaskState[] = [];
  for (const [ref, sha] of refs) {
    const branch = ref.slice(remote.length + 1);
    if (!match.some((m) => branch.startsWith(m))) continue;
    const tasks = listTasks(root);
    if (tasks.some((t) => t.gated?.sha === sha)) continue;
    if (tryGit(root, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== null) continue; // already in
    for (const old of tasks.filter((t) => t.gated?.ref === ref && t.status !== "done")) {
      updateTask(root, old.id, { status: "done", decisions: [`Superseded: ${ref} was pushed again`], next: "Superseded by a newer push" });
      try { removeWorktree(root, old.id, true); } catch { /* keep it */ }
    }
    try {
      gated.push(gateRef(root, ref));
    } catch (error) {
      recordActivity(root, { agent: "agentbrain", kind: "review", text: `Couldn't gate ${ref}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return gated;
}

export function setGateWatch(root: string, watch: { remote?: string; match: string[] } | null): void {
  const project = getProject(root);
  if (watch) project.gate = { ...(watch.remote ? { remote: watch.remote } : {}), match: watch.match };
  else delete project.gate;
  saveProject(root, project);
}

let lastWatch = 0;
/** The control room's sweep: with `agentbrain gate watch` on, look for new bot branches every 10 minutes. */
export function gateSweep(root: string, now = Date.now()): TaskState[] {
  if (!getProject(root).gate || now - lastWatch < WATCH_EVERY_MS) return [];
  lastWatch = now;
  return gateIncoming(root);
}
