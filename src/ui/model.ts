import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getGitState, type GitState } from "../core/git.js";
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
}

export interface Snapshot {
  root: string;
  at: string;
  tasks: LiveTask[];
  sessions: LiveSession[];
}

function liveSession(s: AgentSessionState): LiveSession {
  return {
    agentId: s.agentId,
    sessionId: s.sessionId,
    taskId: s.taskId,
    mode: s.mode === "headless" ? "headless" : "interactive",
    alive: s.mode === "headless" ? sessionAlive(s) : false,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    stopReason: s.stopReason,
    transcript: s.transcript,
  };
}

const ORDER: Record<string, number> = { running: 0, blocked: 1, handoff: 2, checkpoint: 3, review: 4, idle: 5, failed: 6, done: 7 };

export function snapshot(root: string, options: { includeDone?: boolean } = {}): Snapshot {
  const active = getProject(root).activeTaskId;
  const sessions = listSessions(root).map(liveSession);
  const tasks = listTasks(root)
    .filter((t) => options.includeDone || t.status !== "done" || t.id === active)
    .map((task): LiveTask => {
      const workdir = taskWorkdir(root, task);
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
        git: getGitState(workdir),
        warning: describeActivity(taskActivity(root, task, getProject(root).stallMinutes)),
        ...(live ? { liveSession: live } : {}),
      };
    })
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return { root, at: new Date().toISOString(), tasks, sessions };
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
  const add = (dir: string) => {
    try {
      watchers.push(fs.watch(dir, { recursive: true }, (_event, file) => {
        // Ignore git internals and dependency churn.
        if (file && /(^|[/\\])(\.git|node_modules)([/\\]|$)/.test(String(file))) return;
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
