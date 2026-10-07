import fs from "node:fs";
import path from "node:path";
import { getGitState } from "./git.js";
import { makeCheckpoint, renderHandoff, type Checkpoint } from "./handoff.js";
import { tasksDir } from "./paths.js";
import { compilePatterns, redact, redactAll } from "./redact.js";
import { SCHEMA_VERSION, isTaskStatus, TASK_STATUSES } from "./state.js";
import type { AgentRef, TaskState, TaskStatus } from "./state.js";
import {
  getProject,
  getSession,
  getTask,
  latestHandoffFile,
  readJson,
  saveCheckpoint,
  saveProject,
  saveSession,
  saveTask,
} from "./store.js";

/** Uses the explicit id if given, otherwise the project's active task. */
export function resolveTaskId(root: string, id?: string): string {
  const taskId = id ?? getProject(root).activeTaskId;
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
  todo?: string[];
  decisions?: string[];
  failures?: string[];
  blockers?: string[];
  /** Blockers to remove (exact match). */
  unblock?: string[];
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
  for (const item of clean(patch.done)) {
    task.remaining = task.remaining.filter((r) => r !== item);
    if (!task.completed.includes(item)) task.completed.push(item);
  }
  for (const item of clean(patch.todo)) if (!task.remaining.includes(item)) task.remaining.push(item);
  task.decisions.push(...clean(patch.decisions));
  task.failures.push(...clean(patch.failures));
  const unblock = new Set(clean(patch.unblock));
  task.blockers = [...(task.blockers ?? []), ...clean(patch.blockers)].filter((b) => !unblock.has(b));
  if (patch.next !== undefined) task.nextAction = redact(patch.next, extra);
  else if (task.nextAction && task.completed.includes(task.nextAction)) task.nextAction = undefined;
  if (patch.agent) {
    task.agent = patch.agent;
    if (patch.agent.sessionId && !getSession(root, patch.agent.id, patch.agent.sessionId)) {
      saveSession(root, {
        schemaVersion: SCHEMA_VERSION,
        agentId: patch.agent.id,
        sessionId: patch.agent.sessionId,
        taskId: task.id,
        startedAt: new Date().toISOString(),
      });
    }
  }

  // Recording progress implies someone is working on the task.
  if (patch.status === undefined && (task.status === "idle" || task.status === "handoff")) {
    task.status = "running";
  }
  saveTask(root, task);
  return task;
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
  const checkpoint = makeCheckpoint(task, getGitState(root), { agent, stopReason: reason, status });
  const jsonFile = saveCheckpoint(root, task.id, checkpoint);
  const markdownFile = jsonFile.replace(/\.json$/, ".md");
  fs.writeFileSync(markdownFile, renderHandoff(task, checkpoint), "utf8");

  if (agent?.sessionId) {
    const now = new Date().toISOString();
    const existing = getSession(root, agent.id, agent.sessionId);
    saveSession(root, {
      schemaVersion: SCHEMA_VERSION,
      agentId: agent.id,
      sessionId: agent.sessionId,
      taskId: task.id,
      startedAt: existing?.startedAt ?? now,
      ...(status === "handoff" ? { endedAt: now } : {}),
      ...(status === "handoff" && reason ? { stopReason: reason } : {}),
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
  saveSession(root, {
    schemaVersion: SCHEMA_VERSION,
    agentId: agent.id,
    sessionId: agent.sessionId,
    taskId: task.id,
    startedAt: new Date().toISOString(),
  });
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
export function buildPrompt(root: string, taskId: string, cli: string): string {
  const task = getTask(root, taskId);
  const last = latestCheckpoint(root, taskId);
  const live = makeCheckpoint(task, getGitState(root), {
    status: last?.status === "handoff" ? "handoff" : "checkpoint",
    agent: last?.agent ?? task.agent,
    stopReason: last?.status === "handoff" ? last.stopReason : undefined,
  });
  const context = renderHandoff(task, live).replace(/^# AgentBrain Handoff\n/, "");
  const fresh = !last && task.completed.length === 0;

  return `You are ${fresh ? "starting" : "continuing"} a software task tracked by AgentBrain.
${fresh ? "No previous agent has worked on it yet." : "Another agent worked on it before you; its state is below. Do not ask the developer to re-explain the task."}
${context}
## Keeping AgentBrain up to date

You may be cut off at any time (usage limit, crash, session end), so record
progress after each meaningful step — not only at the end:

    ${cli} task update --done "<finished step>" --todo "<new step>" \\
      --decision "<decision and why>" --failure "<what failed and how>" \\
      --next "<the very next action>"

Flags are repeatable. Use --blocker "<text>" if you are stuck on something only the developer can resolve.

- When the objective is complete and verified: ${cli} task update --status review --next "Review the changes"
- If you must stop before finishing:          ${cli} handoff --reason "<why>"
- To see the current state:                   ${cli} status

Never put secrets, tokens or credentials in these fields.
`;
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "done" || status === "failed";
}
