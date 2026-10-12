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
/**
 * Marks an agent as out of quota until a date (or until cleared). For limits
 * AgentBrain can't read from the agent's own output, like Copilot in VS Code.
 */
export function markOutOfQuota(root: string, agentId: string, until?: Date): void {
  if (until && Number.isNaN(until.getTime())) throw new Error("That date isn't valid.");
  const project = getProject(root);
  project.outOfQuota = { ...(project.outOfQuota ?? {}), [agentId]: { at: new Date().toISOString(), ...(until ? { until: until.toISOString() } : {}) } };
  saveProject(root, project);
}

export function clearOutOfQuota(root: string, agentId: string): void {
  const project = getProject(root);
  if (!project.outOfQuota?.[agentId]) return;
  delete project.outOfQuota[agentId];
  if (!Object.keys(project.outOfQuota).length) delete project.outOfQuota;
  saveProject(root, project);
}

/** Why the agent counts as out of quota right now, if the developer said so. */
export function quotaReason(root: string, agentId: string, now = new Date()): string | undefined {
  const mark = getProject(root).outOfQuota?.[agentId];
  if (!mark) return undefined;
  if (mark.until && new Date(mark.until) <= now) return undefined;
  return mark.until ? `out of quota until ${new Date(mark.until).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} (you said so)` : "out of quota (you said so; agentbrain limit <agent> --clear when it's back)";
}
