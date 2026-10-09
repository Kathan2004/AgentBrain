import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getGitState, type GitState } from "../core/git.js";
import { readActivity, type ActivityEvent } from "../core/activity.js";
import { readQueue } from "../core/queue.js";
import { computeTally, faultTolerance, readReputation, reviewPolicy, type Reputation, type Tally } from "../core/review.js";
import { BUILTIN_AGENTS } from "../adapters/registry.js";
import { rankWorkers, type Worker } from "../core/delegate.js";
import { describeActivity, taskActivity } from "../core/stall.js";
import type { AgentSessionState, TaskState } from "../core/state.js";
import { getProject, listSessions, listTasks, sessionAlive } from "../core/store.js";
import { taskWorkdir } from "../core/worktree.js";

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
  completed: string[];
  remaining: string[];
  decisions: string[];
  failures: string[];
  blockers: string[];
  nextAction?: string;
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
}

export interface Snapshot {
  root: string;
  at: string;
  tasks: LiveTask[];
  queue: { id: string; objective: string; status: TaskState["status"] }[];
  sessions: LiveSession[];
  lead?: string;
  activity: ActivityEvent[];
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

export function snapshot(root: string, options: { includeDone?: boolean } = {}): Snapshot {
  const gitCache = new Map<string, GitState>();
  const gitFor = (dir: string) => {
    if (!gitCache.has(dir)) gitCache.set(dir, getGitState(dir));
    return gitCache.get(dir)!;
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
      return {
        id: task.id,
        objective: task.objective,
        status: task.status,
        agent: task.agent?.id,
        updatedAt: task.updatedAt,
        active: task.id === active,
        workdir,
        worktree: task.worktree,
        completed: task.completed,
        remaining: task.remaining,
        decisions: task.decisions,
        failures: task.failures,
        blockers: task.blockers ?? [],
        nextAction: task.nextAction,
        git,
        warning: describeActivity(taskActivity(root, task, stallMinutes, undefined, git)),
        ...(live ? { liveSession: live } : {}),
        ...(task.review ? { review: task.review } : {}),
        reviews: task.reviews ?? [],
        events: task.events ?? [],
        ...(task.status === "review" ? { tally: computeTally(root, task) } : {}),
      };
    })
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
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
    return execFileSync("git", ["diff", "HEAD", "--no-color"], { cwd: workdir, encoding: "utf8", maxBuffer: maxBytes * 4 }).slice(0, maxBytes);
  } catch {
    return "";
  }
}

/** Watches AgentBrain state and task worktrees; calls `onChange` (debounced). */
export function watchProject(root: string, onChange: () => void): () => void {
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
