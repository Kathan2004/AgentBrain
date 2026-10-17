import type { TaskState } from "./state.js";
import { getProject, saveProject } from "./store.js";

/**
 * Model tiers on one platform: the way a strong model can lead (plan, review,
 * take the hard cases) while cheaper models on the same platform do the
 * building. The platform's own id ("claude-code", "codex") stays the lead and
 * runs the lead model; each cheaper model is a worker of its own,
 * "<platform>.<tier>" (claude-code.sonnet, codex.mini), with its own track
 * record, reputation and limits. A tier whose results keep coming back is
 * escalated: the next attempt goes to the next stronger model, the lead last.
 */

export const TIER_PLATFORMS = ["claude-code", "codex"] as const;
export type TierPlatform = (typeof TIER_PLATFORMS)[number];

export interface Tier {
  /** Short name, used in the worker id: claude-code.<name>. */
  name: string;
  /** What to pass the platform's --model / -m. */
  model: string;
}

export interface PlatformModels {
  /** The model the platform's own id runs with: the lead. */
  lead?: string;
  /** Worker models, strongest first. */
  workers: Tier[];
}

/** Times one tier's results may be sent back on a task before the next attempt escalates. */
export const ESCALATE_AFTER = 2;

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function platformModels(root: string, platform: string): PlatformModels | null {
  const m = getProject(root).models?.[platform];
  return m ? { ...(m.lead ? { lead: m.lead } : {}), workers: m.workers ?? [] } : null;
}

export function allModels(root: string): Record<string, PlatformModels> {
  const out: Record<string, PlatformModels> = {};
  for (const [platform, m] of Object.entries(getProject(root).models ?? {})) out[platform] = { ...(m.lead ? { lead: m.lead } : {}), workers: m.workers ?? [] };
  return out;
}

export function setModels(root: string, platform: string, models: PlatformModels | null): PlatformModels | null {
  if (!(TIER_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`Model tiers work with ${TIER_PLATFORMS.join(" and ")} (their CLIs take a model).`);
  const project = getProject(root);
  const all = { ...(project.models ?? {}) };
  if (!models || (!models.lead && !models.workers.length)) delete all[platform];
  else {
    const seen = new Set<string>();
    for (const t of models.workers) {
      if (!NAME.test(t.name)) throw new Error(`Tier name "${t.name}": use lowercase letters, digits and dashes.`);
      if (seen.has(t.name)) throw new Error(`Tier "${t.name}" is listed twice.`);
      if (!t.model.trim()) throw new Error(`Tier "${t.name}" needs a model.`);
      seen.add(t.name);
    }
    all[platform] = { ...(models.lead?.trim() ? { lead: models.lead.trim() } : {}), workers: models.workers.map((t) => ({ name: t.name, model: t.model.trim() })) };
  }
  if (Object.keys(all).length) project.models = all;
  else delete project.models;
  saveProject(root, project);
  return platformModels(root, platform);
}

/** "claude-code.haiku" → its platform and tier; a plain platform id → the platform and its lead model. */
export function resolveWorker(root: string, id: string): { platform: string; tier?: Tier; model?: string } | null {
  const dot = id.indexOf(".");
  const platform = dot < 0 ? id : id.slice(0, dot);
  const models = platformModels(root, platform);
  if (dot < 0) return { platform, ...(models?.lead ? { model: models.lead } : {}) };
  const tier = models?.workers.find((t) => t.name === id.slice(dot + 1));
  return tier ? { platform, tier, model: tier.model } : null;
}

/** Every worker id a platform offers: its tiers, strongest first, then the platform itself (the lead). */
export function ladder(root: string, platform: string): string[] {
  const models = platformModels(root, platform);
  return [...(models?.workers ?? []).map((t) => `${platform}.${t.name}`), platform];
}

/** The model a worker id runs with, for display and the audit trail. */
export function modelOf(root: string, id: string): string | undefined {
  return resolveWorker(root, id)?.model;
}

/**
 * The next stronger worker after `worker` on the same platform, once that
 * worker has had ESCALATE_AFTER results sent back on this task; null when it
 * should simply try again (or there is nothing stronger).
 */
export function escalation(root: string, task: TaskState, worker: string): string | null {
  const dot = worker.indexOf(".");
  if (dot < 0) return null;
  const platform = worker.slice(0, dot);
  const sentBack = (task.reviews ?? []).filter((r) => r.worker === worker && r.verdict === "changes").length;
  if (sentBack < ESCALATE_AFTER) return null;
  // Strongest first: the one listed just before this tier, else the lead.
  const order = ladder(root, platform);
  const i = order.indexOf(worker);
  return i > 0 ? order[i - 1] : i === 0 ? platform : null;
}

/** What the planner is told about the models it can hand pieces to. */
export function tierGuide(root: string): string {
  const lines: string[] = [];
  for (const [platform, m] of Object.entries(allModels(root))) {
    if (!m.workers.length) continue;
    lines.push(`- ${platform} runs ${m.lead ?? "its default model"} (you, the lead: planning, review and the hardest pieces).`,
      ...m.workers.map((t, i) => `- ${platform}.${t.name} runs ${t.model}${i === 0 ? " (strongest worker)" : i === m.workers.length - 1 ? " (cheapest: small, mechanical, well-specified pieces)" : ""}.`));
  }
  if (!lines.length) return "";
  return `## Models you can delegate to (same platform, different strength)

${lines.join("\n")}

Pass the worker id to agentbrain_delegate. Give each piece to the cheapest model that can do it well:
mechanical edits, renames, tests for existing code and docs to the cheapest; pieces that need judgment
across several files to a stronger one. Results that come back twice go to a stronger model by themselves.`;
}
