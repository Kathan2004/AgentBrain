import { findOnPath } from "../adapters/process.js";
import { ACP_AGENTS, BUILTIN_AGENTS, builtinAdapter } from "../adapters/registry.js";
import { getProject, getTask, listSessions, listTasks } from "./store.js";
import { DEFAULT_STALL_MINUTES, taskActivity } from "./stall.js";

/**
 * Suggests which agent should take a task next, with reasons. Grounded in
 * what this project's AgentBrain history shows (usage limits hit, tasks
 * finished, tasks abandoned), not in guesses about models. The developer
 * decides; nothing here launches anything.
 */

export type LaunchMode = "terminal" | "ide" | "headless";

export interface RouteCandidate {
  id: string;
  name: string;
  mode: LaunchMode;
  available: boolean;
  score: number;
  reasons: string[];
  command: string;
}

export interface AgentRecord {
  /** Times the agent moved a task to review or done. */
  finished: number;
  /** Times another agent had to take a task over while this one still had it running. */
  takenOver: number;
  /** Sessions that ended by crashing, timing out or failing to start. */
  failed: number;
  /** Most recent usage/rate-limit stop, if any. */
  lastLimit?: { at: Date; reason: string };
}

const LIMIT = /usage limit|rate limit|rate-limit|quota|too many requests|\b429\b|limit reached/i;
const FAILURE = /exited with code [1-9]|crash|timed out|failed to start|stopped by SIG|error:/i;
/** How long a usage limit is assumed to last when the agent didn't say. */
export const LIMIT_WINDOW_HOURS = 5;

/** Per-agent outcomes across every task in the project. */
export function agentRecords(root: string): Map<string, AgentRecord> {
  const records = new Map<string, AgentRecord>();
  const get = (id: string) => {
    if (!records.has(id)) records.set(id, { finished: 0, takenOver: 0, failed: 0 });
    return records.get(id)!;
  };

  for (const task of listTasks(root)) {
    const events = task.events ?? [];
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event.agent) continue;
      if (event.status === "review" || event.status === "done") {
        // Count the agent that did the work, not a reviewer closing review -> done.
        if (!(event.status === "done" && events[i - 1]?.status === "review")) get(event.agent).finished++;
      }
      const previous = events[i - 1];
      if (event.status === "running" && previous?.status === "running" && previous.agent && previous.agent !== event.agent) {
        get(previous.agent).takenOver++;
      }
    }
  }

  for (const session of listSessions(root)) {
    const reason = session.stopReason ?? "";
    const record = get(session.agentId);
    if (LIMIT.test(reason) && session.endedAt) {
      const at = new Date(session.endedAt);
      if (!record.lastLimit || at > record.lastLimit.at) record.lastLimit = { at, reason };
    } else if (FAILURE.test(reason)) {
      record.failed++;
    }
  }
  return records;
}

function ago(from: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - from.getTime()) / 60_000);
  return minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

export function routeTask(root: string, taskId: string, now = new Date()): RouteCandidate[] {
  const task = getTask(root, taskId);
  const project = getProject(root) as { agents?: { prefer?: string[]; avoid?: string[] }; stallMinutes?: number };
  const prefer = project.agents?.prefer ?? [];
  const avoid = new Set(project.agents?.avoid ?? []);
  const records = agentRecords(root);
  const activity = taskActivity(root, task, project.stallMinutes ?? DEFAULT_STALL_MINUTES, now);

  const candidates: Omit<RouteCandidate, "score" | "reasons">[] = [
    ...BUILTIN_AGENTS.map((def) => ({
      id: def.id,
      name: def.name,
      mode: (def.detached ? "ide" : "terminal") as LaunchMode,
      available: builtinAdapter(def.id)!.available(),
      command: `agentbrain run ${def.id} ${task.id}`,
    })),
    ...ACP_AGENTS.map((def) => ({
      id: def.id,
      name: `${def.name}, headless`,
      mode: "headless" as LaunchMode,
      available: findOnPath(def.command) !== null,
      command: `agentbrain run ${def.id} ${task.id} --headless --timeout 30`,
    })),
  ];

  const ranked = candidates.map((c) => {
    let score = 0;
    const reasons: string[] = [];
    const record = records.get(c.id);

    if (!c.available) reasons.push("not installed");
    if (avoid.has(c.id)) {
      score -= 1000;
      reasons.push("listed under agents.avoid in project.json");
    }
    const rank = prefer.indexOf(c.id);
    if (rank !== -1) {
      score += 20 - rank;
      reasons.push(`preferred in project.json (#${rank + 1})`);
    }

    const limit = record?.lastLimit;
    if (limit && now.getTime() - limit.at.getTime() < LIMIT_WINDOW_HOURS * 3_600_000) {
      score -= 100;
      reasons.push(`hit a usage limit ${ago(limit.at, now)} ("${limit.reason.slice(0, 60)}"); may still be limited`);
    }

    if (record) {
      if (record.finished) {
        score += Math.min(record.finished, 5) * 3;
        reasons.push(`took ${record.finished} task(s) to review/done in this project`);
      }
      if (record.takenOver) {
        score -= record.takenOver * 4;
        reasons.push(`was taken over mid-task ${record.takenOver} time(s)`);
      }
      if (record.failed) {
        score -= record.failed * 3;
        reasons.push(`${record.failed} session(s) crashed, timed out or failed to start`);
      }
    }

    if (task.agent?.id === c.id) {
      if (activity?.stalled) {
        score -= 20;
        reasons.push("currently owns this task but has stalled");
      } else if (task.status === "running") {
        score += 10;
        reasons.push("is working on this task right now");
      } else {
        score += 2;
        reasons.push("worked on this task last");
      }
    }

    // Headless needs an ACP agent and more trust; prefer a visible session when scores tie.
    if (c.mode === "headless") score -= 1;

    return { ...c, score, reasons };
  });

  return ranked.sort((a, b) => Number(b.available) - Number(a.available) || b.score - a.score || a.id.localeCompare(b.id));
}
