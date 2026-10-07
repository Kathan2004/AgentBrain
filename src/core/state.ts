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
  /** Status changes, oldest first (capped): who moved the task where, and when. */
  events?: TaskEvent[];
  /** The task's own Git worktree, when it has one (`agentbrain worktree add`). */
  worktree?: { path: string; branch: string; base: string };
}

export interface TaskEvent {
  at: string;
  status: TaskStatus;
  agent?: string;
}

export interface AgentSessionState {
  schemaVersion: typeof SCHEMA_VERSION;
  agentId: string;
  sessionId: string;
  /** Task the session is working on now. */
  taskId: string;
  /** Every task this session has worked on (one MCP connection can move between tasks). */
  taskIds?: string[];
  startedAt: string;
  endedAt?: string;
  stopReason?: string;
  checkpointId?: string;
}
