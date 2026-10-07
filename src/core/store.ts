import fs from "node:fs";
import path from "node:path";
import { checkpointsDir, brainDir, sessionFile, taskDir, tasksDir } from "./paths.js";
import type { AgentSessionState, TaskState } from "./state.js";

export interface ProjectState {
  schemaVersion: "0.1";
  initializedAt: string;
  activeTaskId?: string;
  /** Extra regexes (JavaScript syntax) whose matches are redacted from stored state. */
  redactPatterns?: string[];
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write then rename so an interrupted write never leaves half a JSON file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function initStore(cwd: string): void {
  fs.mkdirSync(tasksDir(cwd), { recursive: true });
  fs.mkdirSync(path.join(brainDir(cwd), "agents"), { recursive: true });

  const projectFile = path.join(brainDir(cwd), "project.json");
  if (!fs.existsSync(projectFile)) {
    writeJson(projectFile, {
      schemaVersion: "0.1",
      initializedAt: new Date().toISOString(),
    } satisfies ProjectState);
  }
}

export function getProject(cwd: string): ProjectState {
  return readJson<ProjectState>(path.join(brainDir(cwd), "project.json"));
}

export function saveProject(cwd: string, project: ProjectState): void {
  writeJson(path.join(brainDir(cwd), "project.json"), project);
}

export function saveTask(cwd: string, task: TaskState): void {
  task.updatedAt = new Date().toISOString();
  writeJson(path.join(taskDir(cwd, task.id), "task.json"), task);
}

export function getTask(cwd: string, taskId: string): TaskState {
  if (!fs.existsSync(path.join(taskDir(cwd, taskId), "task.json"))) {
    throw new Error(`Task "${taskId}" not found.`);
  }
  return readJson<TaskState>(path.join(taskDir(cwd, taskId), "task.json"));
}

export function listTasks(cwd: string): TaskState[] {
  const dir = tasksDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "task.json")))
    .map((e) => getTask(cwd, e.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Stores a checkpoint. IDs are `cp-<ms>`; if two land in the same millisecond
 * the ID is bumped (mutating `checkpoint`) so neither is overwritten.
 */
export function saveCheckpoint(cwd: string, taskId: string, checkpoint: { checkpointId: string }): string {
  const dir = checkpointsDir(cwd, taskId);
  let n = Number(checkpoint.checkpointId.slice(3));
  while (fs.existsSync(path.join(dir, `${checkpoint.checkpointId}.json`))) {
    checkpoint.checkpointId = `cp-${++n}`;
  }
  const file = path.join(dir, `${checkpoint.checkpointId}.json`);
  writeJson(file, checkpoint);
  return file;
}

export function saveSession(cwd: string, session: AgentSessionState): void {
  writeJson(sessionFile(cwd, session.agentId, session.sessionId), session);
}

export function getSession(cwd: string, agentId: string, sessionId: string): AgentSessionState | null {
  const file = sessionFile(cwd, agentId, sessionId);
  return fs.existsSync(file) ? readJson<AgentSessionState>(file) : null;
}

/** Path of the newest handoff Markdown for a task, or null if none exists. */
export function latestHandoffFile(cwd: string, taskId: string): string | null {
  const dir = checkpointsDir(cwd, taskId);
  if (!fs.existsSync(dir)) return null;
  const latest = fs.readdirSync(dir)
    .filter((x) => x.endsWith(".md"))
    .sort()
    .at(-1);
  return latest ? path.join(dir, latest) : null;
}

export function listSessions(cwd: string): AgentSessionState[] {
  const agentsRoot = path.join(brainDir(cwd), "agents");
  if (!fs.existsSync(agentsRoot)) return [];
  const sessions: AgentSessionState[] = [];
  for (const agent of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    const dir = path.join(agentsRoot, agent.name, "sessions");
    if (!agent.isDirectory() || !fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      sessions.push(readJson<AgentSessionState>(path.join(dir, file)));
    }
  }
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
