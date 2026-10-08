import fs from "node:fs";
import path from "node:path";
import { commitsSince, getGitState } from "./git.js";
import { makeCheckpoint, renderHandoff, type Checkpoint } from "./handoff.js";
import { tasksDir } from "./paths.js";
import { compilePatterns, redact, redactAll } from "./redact.js";
import { describeActivity, taskActivity } from "./stall.js";
import { taskForDir, taskWorkdir } from "./worktree.js";
import { SCHEMA_VERSION, isTaskStatus, TASK_STATUSES } from "./state.js";
import type { AgentRef, AgentSessionState, TaskState, TaskStatus } from "./state.js";
import {
  getProject,
  getSession,
  getTask,
  listTasks,
  latestHandoffFile,
  readJson,
  saveCheckpoint,
  saveProject,
  saveSession,
  saveTask,
} from "./store.js";

/** Uses the explicit id if given, otherwise the project's active task. */
/**
 * Explicit id, else the task whose worktree `dir` is in, else the running task this agent owns (so an agent's commands
 * follow its own task even after the developer switches the active one), else
 * the project's active task.
 */
export function resolveTaskId(root: string, id?: string, agentId?: string, dir?: string): string {
  // Inside a task's worktree, that task is the obvious one.
  const here = !id && dir ? taskForDir(root, dir) : null;
  const owned = !id && !here && agentId
    ? listTasks(root).filter((t) => t.status === "running" && t.agent?.id === agentId)
    : [];
  const taskId = id ?? here?.id ?? (owned.length === 1 ? owned[0].id : getProject(root).activeTaskId);
  if (!taskId) throw new Error('No active task. Create one with: agentbrain task create "<objective>"');
  return taskId;
}

function redactor(root: string): RegExp[] {
  return compilePatterns(getProject(root).redactPatterns);
}

export function createTask(root: string, objective: string): TaskState {
  const text = redact(objective.trim(), redactor(root));
  if (!text) throw new Error("Task objective cannot be empty.");

  let id = `task-${Date.now()}`;
  for (let n = 2; fs.existsSync(path.join(tasksDir(root), id)); n++) id = `task-${Date.now()}-${n}`;

  const now = new Date().toISOString();
  const task: TaskState = {
    schemaVersion: SCHEMA_VERSION,
    id,
    objective: text,
    status: "idle",
    createdAt: now,
    updatedAt: now,
    completed: [],
    remaining: [text],
    decisions: [],
    failures: [],
    blockers: [],
  };
  saveTask(root, task);

  const project = getProject(root);
  project.activeTaskId = id;
  saveProject(root, project);
  return task;
}

export function useTask(root: string, taskId: string): TaskState {
  const task = getTask(root, taskId);
  const project = getProject(root);
  project.activeTaskId = task.id;
  saveProject(root, project);
  return task;
}

export interface TaskPatch {
  status?: string;
  done?: string[];
  drop?: string[];
  todo?: string[];
  decisions?: string[];
  failures?: string[];
  blockers?: string[];
  /** Blockers to remove (text or 1-based number). */
  unblock?: string[];
  /** Known failures that are now fixed (text or 1-based number). */
  fixed?: string[];
  next?: string;
  agent?: AgentRef;
}

/** Applies a progress update. All free text is redacted before it is stored. */
export function updateTask(root: string, taskId: string, patch: TaskPatch): TaskState {
  const task = getTask(root, taskId);
  const extra = redactor(root);
  const clean = (items?: string[]) => redactAll(items ?? [], extra);

  if (patch.status !== undefined) {
    if (!isTaskStatus(patch.status)) {
      throw new Error(`Unknown status "${patch.status}". Use one of: ${TASK_STATUSES.join(", ")}`);
    }
    task.status = patch.status;
  }
  // `--done 2` refers to the second remaining item, as numbered in `status` and the brief.
  // Items can be named by number (as listed in the latest brief/status) or by
  // any unique part of their text, which stays valid as the list changes.
  const byNumber = (list: string[], label: string) => (item: string) => {
    const n = /^#?(\d+)$/.exec(item.trim());
    if (!n) {
      if (list.includes(item)) return item;
      const needle = item.trim().toLowerCase();
      const matches = needle.length >= 3 ? list.filter((x) => x.toLowerCase().includes(needle)) : [];
      return matches.length === 1 ? matches[0] : item;
    }
    const index = Number(n[1]);
    if (index < 1 || index > list.length) {
      throw new Error(`There is no ${label} item ${index} (there ${list.length === 1 ? "is 1" : `are ${list.length}`}).`);
    }
    return list[index - 1];
  };
  for (const item of patch.todo ?? []) {
    if (/^#?\d+$/.test(item.trim())) {
      throw new Error(`"${item}" looks like an item number. To complete remaining item ${item.trim()}, use done instead of todo.`);
    }
  }
  // New items first, so a step added and finished in the same update matches.
  for (const item of clean(patch.todo)) if (!task.remaining.includes(item)) task.remaining.push(item);
  const done = clean(patch.done).map(byNumber(task.remaining, "remaining"));
  const dropped = new Set(clean(patch.drop).map(byNumber(task.remaining, "remaining")));
  const fixed = new Set(clean(patch.fixed).map(byNumber(task.failures, "known-failure")));
  const unblockSet = new Set(clean(patch.unblock).map(byNumber(task.blockers ?? [], "blocker")));
  for (const item of done) {
    task.remaining = task.remaining.filter((r) => r !== item);
    if (!task.completed.includes(item)) task.completed.push(item);
  }
  task.remaining = task.remaining.filter((item) => !dropped.has(item));
  task.decisions.push(...clean(patch.decisions));
  task.failures = [...task.failures.filter((f) => !fixed.has(f)), ...clean(patch.failures)];
  task.blockers = [...(task.blockers ?? []).filter((b) => !unblockSet.has(b)), ...clean(patch.blockers)];
  if (patch.next !== undefined) task.nextAction = redact(patch.next, extra);
  else if (task.nextAction && task.completed.includes(task.nextAction)) task.nextAction = undefined;
  if (patch.agent) {
    task.agent = patch.agent;
    if (patch.agent.sessionId) {
      const session = getSession(root, patch.agent.id, patch.agent.sessionId);
      if (!session || session.taskId !== task.id) {
        recordSession(root, { id: patch.agent.id, sessionId: patch.agent.sessionId }, task.id);
      }
    }
  }

  // Finishing the task finishes its objective; agents never tick that item off themselves.
  if ((task.status === "review" || task.status === "done") && task.remaining.includes(task.objective)) {
    task.remaining = task.remaining.filter((r) => r !== task.objective);
    if (!task.completed.includes(task.objective)) task.completed.push(task.objective);
  }

  // Recording progress implies someone is working on the task.
  if (patch.status === undefined && (task.status === "idle" || task.status === "handoff")) {
    task.status = "running";
  }
  saveTask(root, task);
  return task;
}

/**
 * Creates or updates a session record without losing its history: the start
 * time is kept and every task the session touches is remembered.
 */
function recordSession(
  root: string,
  agent: Required<AgentRef>,
  taskId: string,
  changes: Partial<Pick<AgentSessionState, "endedAt" | "stopReason" | "checkpointId">> = {},
): void {
  const existing = getSession(root, agent.id, agent.sessionId);
  const taskIds = [...new Set([...(existing?.taskIds ?? (existing ? [existing.taskId] : [])), taskId])];
  const session: AgentSessionState = {
    schemaVersion: SCHEMA_VERSION,
    agentId: agent.id,
    sessionId: agent.sessionId,
    taskId,
    taskIds,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    ...(existing?.checkpointId ? { checkpointId: existing.checkpointId } : {}),
    ...changes,
  };
  if (!changes.endedAt) {
    delete session.endedAt;
    delete session.stopReason;
  }
  saveSession(root, session);
}

export interface CheckpointResult {
  task: TaskState;
  checkpoint: Checkpoint;
  jsonFile: string;
  markdownFile: string;
}

/**
 * Snapshots task + Git state. With status "handoff" (the default) the task is
 * marked `handoff` and the agent's session record is closed; with
 * "checkpoint" the task keeps running.
 */
export function writeCheckpoint(
  root: string,
  taskId: string,
  options: { agent?: AgentRef; reason?: string; status?: Checkpoint["status"] } = {},
): CheckpointResult {
  const task = getTask(root, taskId);
  const status = options.status ?? "handoff";
  const agent = options.agent ?? task.agent;
  const reason = options.reason === undefined ? undefined : redact(options.reason, redactor(root));
  const checkpoint = makeCheckpoint(task, getGitState(taskWorkdir(root, task)), { agent, stopReason: reason, status });
  const jsonFile = saveCheckpoint(root, task.id, checkpoint);
  const markdownFile = jsonFile.replace(/\.json$/, ".md");
  fs.writeFileSync(markdownFile, renderHandoff(task, checkpoint), "utf8");

  if (agent?.sessionId) {
    const ending = status === "handoff" ? { endedAt: new Date().toISOString(), ...(reason ? { stopReason: reason } : {}) } : {};
    recordSession(root, { id: agent.id, sessionId: agent.sessionId }, task.id, {
      ...ending,
      checkpointId: checkpoint.checkpointId,
    });
  }

  if (status === "handoff") {
    task.status = "handoff";
    saveTask(root, task);
  } else if (task.status === "idle") {
    task.status = "running";
    saveTask(root, task);
  }
  return { task, checkpoint, jsonFile, markdownFile };
}

/** A new agent session takes over the task: status → running, session opened. */
export function takeOver(root: string, taskId: string, agent: Required<AgentRef>): TaskState {
  const task = getTask(root, taskId);
  task.status = "running";
  task.agent = agent;
  saveTask(root, task);
  recordSession(root, agent, task.id);
  return task;
}

/** Marks a session ended without touching the task (used when the agent handed off itself). */
export function closeSession(root: string, agent: Required<AgentRef>, reason?: string): void {
  const session = getSession(root, agent.id, agent.sessionId);
  if (!session || session.endedAt) return;
  saveSession(root, {
    ...session,
    endedAt: new Date().toISOString(),
    ...(reason ? { stopReason: redact(reason, redactor(root)) } : {}),
  });
}

export function latestCheckpoint(root: string, taskId: string): Checkpoint | null {
  const md = latestHandoffFile(root, taskId);
  return md ? readJson<Checkpoint>(md.replace(/\.md$/, ".json")) : null;
}

/**
 * The text handed to an agent: current task + Git state (live, not the stale
 * snapshot), attributed to the last handoff, plus instructions for keeping
 * AgentBrain up to date so the *next* switch is lossless too.
 */
/**
 * The state half of the brief: live task + Git state (not the stale snapshot),
 * attributed to the last handoff. Written so the reader continues the work as
 * its own rather than as a stranger reading someone else's notes.
 */
export function briefContext(root: string, taskId: string): string {
  const task = getTask(root, taskId);
  const last = latestCheckpoint(root, taskId);
  const live = makeCheckpoint(task, getGitState(taskWorkdir(root, task)), {
    status: last?.status === "handoff" ? "handoff" : "checkpoint",
    agent: last?.agent ?? task.agent,
    stopReason: last?.status === "handoff" ? last.stopReason : undefined,
  });
  const context = renderHandoff(task, live).replace(/^# AgentBrain Handoff\n/, "");
  const fresh = !last && task.completed.length === 0;
  const intro = fresh
    ? `You are starting AgentBrain task ${task.id}. Nobody has worked on it yet.`
    : `You are continuing AgentBrain task ${task.id}. This is your task: earlier sessions (in this or ` +
      "another coding agent) did the work below. Pick up exactly where it left off, as if you had done it " +
      "yourself; do not ask the developer to re-explain.";
  const warning = describeActivity(taskActivity(root, task, getProject(root).stallMinutes));
  const note = warning
    ? `\n> Note: ${warning} If you are taking over, continue from the next action; your first update makes the task yours.\n`
    : "";
  return `${intro}\n${note}${context}${taskCommitsSection(root, task)}`;
}

/** First Git HEAD recorded for a task: where its work started. */
function taskStart(root: string, task: TaskState): string | null {
  if (task.worktree) return task.worktree.base;
  const dir = path.join(tasksDir(root), task.id, "checkpoints");
  if (!fs.existsSync(dir)) return null;
  const first = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()[0];
  return first ? readJson<Checkpoint>(path.join(dir, first)).git.head : null;
}

/**
 * Commits made on the task so far, so the next agent sees what actually
 * changed, not only what earlier agents reported.
 */
function taskCommitsSection(root: string, task: TaskState): string {
  const commits = commitsSince(taskWorkdir(root, task), taskStart(root, task));
  if (!commits.length) return "";
  return `\n## Commits on this task (newest first)\n${commits.map((c) => `- ${c}`).join("\n")}\n`;
}

export function buildPrompt(root: string, taskId: string, cli: string): string {
  const id = getTask(root, taskId).id;
  return `${briefContext(root, taskId)}
## Keeping AgentBrain up to date

You may be cut off at any time (usage limit, crash, session end), so record
progress after each meaningful step — not only at the end:

    ${cli} task update --task ${id} --done "<finished step>" --todo "<new step>" \\
      --decision "<decision and why>" --failure "<what failed and how>" \\
      --next "<the very next action>"

Flags are repeatable. \`--done\` and \`--fixed\` take the item's text or any unique part of it (numbers also work but shift as items complete). Use --blocker "<text>" if you are stuck on something only the developer can resolve.

- When the objective is complete and verified: ${cli} task update --task ${id} --status review --next "Review the changes"
- If you must stop before finishing:          ${cli} handoff ${id} --reason "<why>"
- To see the current state:                   ${cli} resume ${id}

Never put secrets, tokens or credentials in these fields.
`;
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "failed";
}
