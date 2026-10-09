import { getProject, listTasks, saveProject, type AgentLimits, type ProjectState } from "./store.js";

function validLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function effectiveLimits(project: ProjectState, agentId: string): AgentLimits {
  return { ...project.limits?.default, ...project.limits?.[agentId] };
}

export function getLimits(root: string): Record<string, AgentLimits> {
  return getProject(root).limits ?? {};
}

export function setLimits(root: string, agentId: string, patch: AgentLimits | null): void {
  if (!agentId.trim()) throw new Error("Agent id cannot be empty.");
  if (patch) {
    for (const [name, value] of Object.entries(patch)) {
      if (value !== undefined && !validLimit(value)) throw new Error(`${name} must be a positive integer.`);
    }
  }
  const project = getProject(root);
  project.limits = { ...(project.limits ?? {}) };
  if (patch === null) delete project.limits[agentId];
  else project.limits[agentId] = { ...(project.limits[agentId] ?? {}), ...patch };
  if (!Object.keys(project.limits[agentId] ?? {}).length) delete project.limits[agentId];
  if (!Object.keys(project.limits).length) delete project.limits;
  saveProject(root, project);
}

export function limitReason(root: string, agentId: string, now = new Date()): string | undefined {
  const limits = effectiveLimits(getProject(root), agentId);
  const tasks = listTasks(root);
  if (limits.maxParallel !== undefined) {
    const running = tasks.filter((task) => task.status === "running" && task.agent?.id === agentId).length;
    if (running >= limits.maxParallel) return `at its limit of ${limits.maxParallel} parallel tasks`;
  }
  if (limits.dailyTasks !== undefined) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const delegated = tasks.filter((task) => task.delegatedTo?.worker === agentId &&
      new Date(task.delegatedTo.at).getTime() >= midnight.getTime() &&
      new Date(task.delegatedTo.at).getTime() <= now.getTime()).length;
    if (delegated >= limits.dailyTasks) return `at its daily limit of ${limits.dailyTasks} delegated tasks`;
  }
  return undefined;
}

export function runTimeoutMinutes(root: string, agentId: string): number | undefined {
  return effectiveLimits(getProject(root), agentId).maxRunMinutes;
}