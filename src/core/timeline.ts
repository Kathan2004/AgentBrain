import fs from "node:fs";
import path from "node:path";
import { checkpointsDir } from "./paths.js";
import { listSessions, readJson } from "./store.js";
import type { AgentSessionState } from "./state.js";

interface StoredCheckpoint {
  checkpointId: string;
  timestamp: string;
  status: "checkpoint" | "handoff";
  agent: { id: string; sessionId?: string };
  stopReason?: string;
}

export type TimelineEventKind = "start" | "checkpoint" | "handoff" | "end";

export interface TimelineEvent {
  timestamp: string;
  agent: string;
  event: TimelineEventKind;
  reason: string;
  sessionId?: string;
  checkpointId?: string;
}

function sessionEvents(session: AgentSessionState): TimelineEvent[] {
  const events: TimelineEvent[] = [{
    timestamp: session.startedAt,
    agent: session.agentId,
    event: "start",
    reason: `session ${session.sessionId}`,
    sessionId: session.sessionId,
  }];
  if (session.endedAt) {
    events.push({
      timestamp: session.endedAt,
      agent: session.agentId,
      event: "end",
      reason: session.stopReason ?? `session ${session.sessionId} ended`,
      sessionId: session.sessionId,
    });
  }
  return events;
}

function checkpointEvents(cwd: string, taskId: string): TimelineEvent[] {
  const dir = checkpointsDir(cwd, taskId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson<StoredCheckpoint>(path.join(dir, file)))
    .map((checkpoint) => ({
      timestamp: checkpoint.timestamp,
      agent: checkpoint.agent.id,
      event: checkpoint.status,
      reason: checkpoint.stopReason ?? checkpoint.status,
      ...(checkpoint.agent.sessionId ? { sessionId: checkpoint.agent.sessionId } : {}),
      checkpointId: checkpoint.checkpointId,
    }));
}

/** Return the session and checkpoint history for a task, oldest event first. */
export function taskTimeline(cwd: string, taskId: string): TimelineEvent[] {
  const checkpoints = checkpointEvents(cwd, taskId);
  const events = listSessions(cwd)
    .filter((session) => session.taskId === taskId || session.taskIds?.includes(taskId))
    .flatMap(sessionEvents)
    // A session that ended by handing off already shows as that handoff.
    .filter((e) => !(e.event === "end" && checkpoints.some(
      (c) => c.event === "handoff" && c.sessionId === e.sessionId && c.reason === e.reason,
    )))
    .concat(checkpoints);
  const order: Record<TimelineEventKind, number> = { start: 0, checkpoint: 1, handoff: 2, end: 3 };
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || order[a.event] - order[b.event] || a.agent.localeCompare(b.agent));
}