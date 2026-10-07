export const SCHEMA_VERSION = "0.1" as const;

export const TASK_STATUSES = [
  "idle",
  "running",
  "checkpoint",
  "handoff",
  "review",
  "blocked",
  "failed",
  "done",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export interface AgentRef {
  id: string;
  sessionId?: string;
}

export interface TaskState {
  schemaVersion?: typeof SCHEMA_VERSION;
  id: string;
  objective: string;
  status: TaskStatus;
  createdAt?: string;
  updatedAt?: string;
  completed: string[];
  remaining: string[];
  decisions: string[];
  failures: string[];
  blockers?: string[];
  nextAction?: string;
  /** The agent currently (or most recently) working on the task. */
  agent?: AgentRef;
}

export interface AgentSessionState {
  schemaVersion: typeof SCHEMA_VERSION;
  agentId: string;
  sessionId: string;
  taskId: string;
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
  checkpointId?: string;
}
