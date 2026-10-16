import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { firstStep } from "../core/actions.js";
import path from "node:path";
import { getGitState, type GitState } from "../core/git.js";
import { readActivity, type ActivityEvent } from "../core/activity.js";
import { readQueue } from "../core/queue.js";
import { computeTally, faultTolerance, readReputation, reviewPolicy, reviewPriority, type Reputation, type Tally } from "../core/review.js";
import { BUILTIN_AGENTS } from "../adapters/registry.js";
import { rankWorkers, type Worker } from "../core/delegate.js";
import { describeActivity, taskActivity } from "../core/stall.js";
import type { AgentSessionState, TaskState } from "../core/state.js";
import { getProject, listSessions, listTasks, sessionAlive } from "../core/store.js";
import { taskWorkdir } from "../core/worktree.js";
import { gitBinary } from "../core/platform.js";
import { checkpointsDir } from "../core/paths.js";

/**
 * One read-only snapshot of everything AgentBrain knows, for live views (the
 * terminal app and the web page render the same data).
 */
export interface LiveSession {
  agentId: string;
  sessionId: string;
  taskId: string;
  mode: "headless" | "interactive";
  /** Headless process still running. */
  alive: boolean;
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
  transcript?: string;
  /** working / idle for hook-reported sessions, running for headless ones, ended once over. */
  state: "working" | "idle" | "running" | "ended";
  lastSeenAt?: string;
  lastAction?: string;
}

export interface LiveTask {
  id: string;
  objective: string;
  status: TaskState["status"];
  agent?: string;
  updatedAt?: string;
  active: boolean;
  workdir: string;
  worktree?: TaskState["worktree"];
  merged?: boolean;
  completed: string[];
  remaining: string[];
  decisions: string[];
  failures: string[];
  blockers: string[];
  nextAction?: string;
  /** Who handed the task out, and the developer's own words behind it. */
  requestedBy?: string;
  request?: string;
  git: GitState;
  warning: string | null;
  /** The headless session working on this task right now, if any. */
  liveSession?: LiveSession;
  /** Set while the task waits for the lead agent. */
  review?: TaskState["review"];
  reviews: NonNullable<TaskState["reviews"]>;
  events: NonNullable<TaskState["events"]>;
  /** Where the votes stand, while in review. */
  tally?: Tally;
  /** What the task's branch adds on top of its base, PR-style (worktree tasks that are running, in review or handed off). */
  changes?: ChangeSummary;
}

export interface ChangeSummary {
  commits: number;
  files: number;
  added: number;
  removed: number;
}

export interface Snapshot {
  root: string;
  at: string;
  tasks: LiveTask[];
  queue: { id: string; objective: string; status: TaskState["status"] }[];
  sessions: LiveSession[];
  lead?: string;
  activity: ActivityEvent[];
  permissions: "ask" | "all";
  policy: { mode: "none" | "lead" | "council"; reviewers: string[]; quorum: number; checks: string[]; tolerates: number };
  reputation: Record<string, Reputation>;
  /** Agents the developer can pick as reviewers: built-in ones plus any seen in this repo. */
  knownAgents: string[];
  /** Who prompts can be delegated to, best first for the next task, with reasons. */
  workers: (Worker & { reasons: string[] })[];
  /** A pinned worker; otherwise AgentBrain picks per task. */
  worker?: string;
}

/** An interactive session not heard from in this long is treated as gone. */
const PRESENCE_MS = 30 * 60_000;

function sessionState(s: AgentSessionState, alive: boolean): LiveSession["state"] {
  if (s.mode === "headless") return alive ? "running" : "ended";
  if (s.endedAt) return "ended";
  const seen = Date.parse(s.lastSeenAt ?? s.startedAt);
  if (!s.lastSeenAt || Date.now() - seen > PRESENCE_MS) return "ended";
  return s.activity ?? "idle";
}

/** Whether a session counts as present: the web's "Working now" and the console's count agree. */
export function sessionPresent(s: AgentSessionState): boolean {
  return sessionState(s, s.mode === "headless" ? sessionAlive(s) : false) !== "ended";
}

function liveSession(s: AgentSessionState): LiveSession {
  const alive = s.mode === "headless" ? sessionAlive(s) : false;
  return {
    state: sessionState(s, alive),
    ...(s.lastSeenAt ? { lastSeenAt: s.lastSeenAt } : {}),
    ...(s.lastAction ? { lastAction: s.lastAction } : {}),
    agentId: s.agentId,
    sessionId: s.sessionId,
    taskId: s.taskId,
    mode: s.mode === "headless" ? "headless" : "interactive",
    alive,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    stopReason: s.stopReason,
    transcript: s.transcript,
  };
}

const ORDER: Record<string, number> = { running: 0, blocked: 1, handoff: 2, checkpoint: 3, review: 4, idle: 5, failed: 6, done: 7 };

const NO_CHANGES: GitState = { head: null, branch: null, dirty: false, changedFiles: [] };

/** Git state per folder, reused for a few seconds: the control room polls every 3 s, and git is a process per call. */
const gitStates = new Map<string, { at: number; state: GitState }>();
const GIT_STATE_TTL_MS = 10_000;

export function snapshot(root: string, options: { includeDone?: boolean } = {}): Snapshot {
  const gitFor = (dir: string) => {
    const hit = gitStates.get(dir);
    if (hit && Date.now() - hit.at < GIT_STATE_TTL_MS) return hit.state;
    const state = getGitState(dir);
    gitStates.set(dir, { at: Date.now(), state });
    return state;
  };
  const stallMinutes = getProject(root).stallMinutes;
  const active = getProject(root).activeTaskId;
  const sessions = listSessions(root).map(liveSession);
  const allTasks = listTasks(root);
  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  // Agents connected only over MCP (e.g. Copilot in VS Code) report no presence; owning a running task counts.
  for (const s of sessions) {
    const owner = taskById.get(s.taskId);
    if (s.state === "ended" && !s.endedAt && s.mode !== "headless" && owner?.status === "running" && owner.agent?.sessionId === s.sessionId) {
      s.state = "working";
    }
  }
  const queue = readQueue(root).flatMap((id) => {
    const task = taskById.get(id);
    return task ? [{ id: task.id, objective: task.objective, status: task.status }] : [];
  });
  const tasks = allTasks
    .filter((t) => options.includeDone || t.status !== "done" || t.id === active)
    .map((task): LiveTask => {
      const workdir = taskWorkdir(root, task);
      // Git is the expensive part (one process per call): run it once per folder,
      // and not at all for finished tasks.
      const git = task.status === "done" ? NO_CHANGES : gitFor(workdir);
      const live = sessions.find((s) => s.taskId === task.id && s.alive);
      const changes = changeSummary(root, task);
      return {
        id: task.id,
        objective: task.objective,
        status: task.status,
        agent: task.agent?.id,
        updatedAt: task.updatedAt,
        active: task.id === active,
        workdir,
        worktree: task.worktree,
        ...(task.merged ? { merged: true } : {}),
        completed: task.completed,
        remaining: task.remaining,
        decisions: task.decisions,
        failures: task.failures,
        blockers: task.blockers ?? [],
        nextAction: task.nextAction,
        ...(task.requestedBy ? { requestedBy: task.requestedBy } : {}),
        ...(task.request ? { request: task.request } : {}),
        git,
        warning: describeActivity(taskActivity(root, task, stallMinutes, undefined, git)),
        ...(live ? { liveSession: live } : {}),
        ...(task.review ? { review: task.review } : {}),
        reviews: task.reviews ?? [],
        events: task.events ?? [],
        ...(task.status === "review" ? { tally: computeTally(root, task) } : {}),
        ...(changes ? { changes } : {}),
      };
    })
    .sort((a, b) =>
      (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
      (b.review ? reviewPriority(b) : 0) - (a.review ? reviewPriority(a) : 0) ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
  const project = getProject(root);
  const policy = reviewPolicy(root);
  const known = new Set<string>([...BUILTIN_AGENTS.map((a) => a.id), ...sessions.map((s) => s.agentId), ...policy.reviewers]);
  return {
    root,
    at: new Date().toISOString(),
    tasks,
    queue,
    sessions,
    ...(project.lead ? { lead: project.lead } : {}),
    activity: readActivity(root, 300),
    policy: { ...policy, tolerates: policy.mode === "council" ? faultTolerance(policy.reviewers.length, policy.quorum) : 0 },
    reputation: readReputation(root),
    knownAgents: [...known].sort(),
    workers: rankWorkers(root).map((c) => ({ ...c.worker, reasons: c.reasons })),
    ...(project.worker ? { worker: project.worker } : {}),
    permissions: project.permissions === "all" ? "all" : "ask",
  };
}

/** Last `lines` lines of a headless session's transcript. */
export function transcriptTail(file: string | undefined, lines = 40): string[] {
  if (!file || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  return text.split("\n").filter(Boolean).slice(-lines);
}

/** Unified diff of a task's uncommitted changes (tracked files), capped. */
export function taskDiff(workdir: string, maxBytes = 200_000): string {
  try {
    return execFileSync(gitBinary(), ["diff", "HEAD", "--no-color"], { cwd: workdir, encoding: "utf8", maxBuffer: maxBytes * 4 }).slice(0, maxBytes);
  } catch {
    return "";
  }
}

export interface TaskChanges {
  /** What the work amounts to: the agent's own words, else its commit subjects. */
  summary: string;
  commits: { sha: string; subject: string; body: string; author: string; at: string }[];
  files: { path: string; added: number; removed: number; status: string }[];
  /** Unified diff of everything the task changed (commits plus uncommitted edits), capped. */
  patch: string;
  truncated: boolean;
  uncommitted: boolean;
  /** Worked straight on main: the commits made there while the task was open, which may include other work. */
  approximate?: boolean;
}

const baseCache = new Map<string, string | null>();

/**
 * Where a finished task's branch started, once its worktree is gone: the
 * recorded base, else the main-line parent of the merge that brought it in,
 * else the branch's last commit from before the task was created.
 */
async function mergedBase(root: string, task: TaskState, tip: string): Promise<string | null> {
  if (task.merged?.base) return task.merged.base;
  if (baseCache.has(task.id)) return baseCache.get(task.id)!;
  let base: string | null = null;
  const merges = await gitOut(root, ["rev-list", "--all", "--merges", "--parents"]);
  const merge = merges.split("\n").map((l) => l.trim().split(" ")).find((p) => p.slice(2).includes(tip));
  if (merge) base = (await gitOut(root, ["merge-base", merge[1], tip])).trim() || null;
  // Landed per file (no merge commit): where main was just before it landed.
  if (!base && task.merged?.landed) base = (await gitOut(root, ["merge-base", `${task.merged.landed}^`, tip])).trim() || null;
  if (!base && task.createdAt) base = (await gitOut(root, ["rev-list", "-1", "--first-parent", `--before=${task.createdAt}`, tip])).trim() || null;
  if (base === tip) base = null;
  baseCache.set(task.id, base);
  return base;
}

/** A task done straight on main (no worktree): the HEADs AgentBrain saw at its first and last checkpoint. */
function checkpointRange(root: string, task: TaskState): { base: string; tip: string } | null {
  const dir = checkpointsDir(root, task.id);
  if (!fs.existsSync(dir)) return null;
  const heads = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
    try {
      const head = (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { git?: { head?: string; branch?: string } }).git;
      return head?.head ? [head.head] : [];
    } catch { return []; }
  });
  return heads.length >= 2 && heads[0] !== heads.at(-1) ? { base: heads[0], tip: heads.at(-1)! } : null;
}

const execFileAsync = promisify(execFile);

/** git, without blocking the control room's event loop; "" on failure. */
async function gitOut(cwd: string, args: string[], maxBytes = 2_000_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(gitBinary(), args, { cwd, encoding: "utf8", maxBuffer: maxBytes * 4 });
    return stdout;
  } catch {
    return "";
  }
}

/** git for the snapshot's cheap per-task summary (cached by branch tip, so rarely run); "" on failure. */
function gitSync(cwd: string, args: string[]): string {
  try {
    return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

const SUMMARY_STATUSES: TaskState["status"][] = ["running", "review", "handoff"];
/** Keyed by root, base and branch tip: the snapshot poll only reruns git when the branch moved. */
const summaryCache = new Map<string, ChangeSummary>();

/**
 * Commits, files and +/- lines on a task's branch since its base, for the task
 * list. One rev-parse per call; rev-list and diff only when the tip changed.
 */
export function changeSummary(root: string, task: TaskState): ChangeSummary | undefined {
  const wt = task.worktree;
  if (!wt?.base || !wt.branch || !SUMMARY_STATUSES.includes(task.status)) return undefined;
  const tip = gitSync(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}^{commit}`]).trim();
  if (!tip) return undefined;
  const key = `${root}\0${wt.base}\0${tip}`;
  const cached = summaryCache.get(key);
  if (cached) return cached;
  const range = `${wt.base}..${tip}`;
  const stat = gitSync(root, ["diff", "--shortstat", range]);
  const count = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
  const summary: ChangeSummary = {
    commits: Number(gitSync(root, ["rev-list", "--count", range]).trim()) || 0,
    files: count(/(\d+) files? changed/),
    added: count(/(\d+) insertions?\(\+\)/),
    removed: count(/(\d+) deletions?\(-\)/),
  };
  if (summaryCache.size > 500) summaryCache.clear();
  summaryCache.set(key, summary);
  return summary;
}

const changesCache = new Map<string, { key: string; at: number; value: TaskChanges }>();

/**
 * Everything a task changed, the way a pull request shows it: from the commit
 * its worktree branched from to the branch tip (or the tip that was merged),
 * plus edits not yet committed. Git runs in parallel and off the event loop;
 * the result is reused until the task or its branch moves.
 */
export async function taskChanges(root: string, task: TaskState, maxBytes = 400_000): Promise<TaskChanges> {
  const workdir = taskWorkdir(root, task);
  let base = task.worktree?.base;
  // A finished task's worktree is gone: then the root's own edits aren't this task's.
  const live = Boolean(task.worktree && fs.existsSync(task.worktree.path));
  const refs = [task.worktree?.branch, task.merged?.commit].filter((r): r is string => Boolean(r));
  const shas = await Promise.all(refs.map((ref) => gitOut(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then((x) => x.trim())));
  const tipIndex = shas.findIndex(Boolean);
  let tip = tipIndex >= 0 ? refs[tipIndex] : undefined;
  let approximate = false;
  if (!base && tip && tipIndex >= 0) base = (await mergedBase(root, task, shas[tipIndex])) ?? undefined;
  if (!task.worktree && !task.merged) {
    const span = checkpointRange(root, task);
    if (span) { base = span.base; tip = span.tip; approximate = true; }
  }
  const range = base && tip ? `${base}..${tip}` : null;

  // Same task state, same branch tip and (for live worktrees) a few seconds old: reuse.
  const key = `${task.updatedAt}|${tipIndex >= 0 ? shas[tipIndex] : ""}|${base ?? ""}`;
  const hit = changesCache.get(task.id);
  if (hit && hit.key === key && (!live || Date.now() - hit.at < 5_000)) return hit.value;

  const [log, committedPatch, pendingPatch, numCommitted, numPending, namesCommitted, namesPending] = await Promise.all([
    range ? gitOut(root, ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1f%an%x1f%aI%x1e", range]) : "",
    range ? gitOut(root, ["diff", "--no-color", "-M", base!, tip!]) : "",
    live ? gitOut(workdir, ["diff", "HEAD", "--no-color", "-M"]) : "",
    range ? gitOut(root, ["diff", "--numstat", "-M", base!, tip!]) : "",
    live ? gitOut(workdir, ["diff", "--numstat", "HEAD", "-M"]) : "",
    range ? gitOut(root, ["diff", "--name-status", "-M", base!, tip!]) : "",
    live ? gitOut(workdir, ["diff", "--name-status", "-M", "HEAD"]) : "",
  ]);
  const commits = log.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, subject, body, author, at] = r.split("\x1f");
    return { sha, subject, body: (body ?? "").trim(), author, at };
  });
  const stats = new Map<string, { path: string; added: number; removed: number; status: string }>();
  for (const out of [numCommitted, numPending]) {
    for (const line of out.split("\n")) {
      const [a, r, ...rest] = line.split("\t");
      if (!rest.length) continue;
      const file = rest.join("\t");
      const prev = stats.get(file) ?? { path: file, added: 0, removed: 0, status: "modified" };
      prev.added += a === "-" ? 0 : Number(a);
      prev.removed += r === "-" ? 0 : Number(r);
      stats.set(file, prev);
    }
  }
  // What the branch did to a file wins over a later uncommitted edit (a new file stays "added").
  const named = new Set<string>();
  for (const out of [namesCommitted, namesPending]) {
    for (const line of out.split("\n")) {
      const [code, ...names] = line.split("\t");
      const file = names[names.length - 1];
      const entry = file && stats.get(file);
      if (!entry || named.has(file)) continue;
      named.add(file);
      entry.status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified";
    }
  }
  const full = committedPatch + pendingPatch;
  // What the agent recorded as done; else its own handoff note; else its commit subjects.
  const system = /run ended|exited with code|exit code|session limit|usage limit|end_turn|stop reason|timed out|^error|^stopped|^killed/i;
  const said = listSessions(root)
    .filter((x) => x.taskId === task.id && x.stopReason && !system.test(x.stopReason))
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))[0]?.stopReason;
  // A step that is just the objective (older tasks seeded it whole) says nothing new.
  const steps = task.completed.filter((c) => c !== task.objective && c !== firstStep(task.objective)).map((c) => (c.length > 240 ? `${c.slice(0, 239).trimEnd()}…` : c));
  // The task's own commits say best what it did; steps are often bookkeeping ("Update tests").
  const subjects = approximate ? [] : commits.map((c) => c.subject).reverse().slice(-4);
  const summary = subjects.length ? subjects.join(" · ") : steps.length ? steps.slice(-4).join(" · ") : said ?? "";
  const value: TaskChanges = {
    summary,
    commits,
    files: [...stats.values()],
    patch: full.slice(0, maxBytes),
    truncated: full.length > maxBytes,
    uncommitted: Boolean(pendingPatch),
    ...(approximate ? { approximate } : {}),
  };
  changesCache.set(task.id, { key, at: Date.now(), value });
  return value;
}

/** Watches AgentBrain state and task worktrees; calls `onChange` (debounced). */
export function watchProject(root: string, onChange: () => void, onFile?: (absFile: string) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 200);
  };
  const watchers: fs.FSWatcher[] = [];
  const vault = path.join(root, ".agentbrain", "vault") + path.sep;
  const add = (dir: string) => {
    try {
      watchers.push(fs.watch(dir, { recursive: true }, (_event, file) => {
        // Ignore git internals and dependency churn.
        if (file && /(^|[/\\])(\.git|node_modules)([/\\]|$)/.test(String(file))) return;
        // The vault is written from these events; reacting to it would loop.
        if (file && path.join(dir, String(file)).startsWith(vault)) return;
        if (file && onFile) onFile(path.join(dir, String(file)));
        fire();
      }));
    } catch {
      // directory vanished
    }
  };
  add(path.join(root, ".agentbrain"));
  add(root);
  // Polling as a backstop: git state can change without file events we see.
  const poll = setInterval(fire, 3000);
  return () => {
    watchers.forEach((w) => w.close());
    clearInterval(poll);
    if (timer) clearTimeout(timer);
  };
}
