import fs from "node:fs";
import path from "node:path";
import { checkpointsDir, brainDir, sessionFile, taskDir, tasksDir } from "./paths.js";
import type { AgentSessionState, TaskState } from "./state.js";

export interface ProjectState {
  schemaVersion: "0.1";
  initializedAt: string;
  activeTaskId?: string;
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

export function saveCheckpoint(cwd: string, taskId: string, checkpoint: unknown): string {
  const id = (checkpoint as { checkpointId: string }).checkpointId;
  const dir = checkpointsDir(cwd, taskId);
  const file = path.join(dir, `${id}.json`);
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
