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
  /** Set by `agentbrain worktree merge`: which branch tip was merged, so cleanup can trust it after a squash. */
  merged?: { branch: string; commit: string; at: string };
  /** Set while the task waits for review: who finished it, votes, AgentBrain's own checks, flags. */
  review?: ReviewState;
  /** Decisions on earlier submissions, oldest first. */
  reviews?: ReviewVerdict[];
  /** The task this one was split from (set when an agent delegates part of its work). */
  parent?: string;
  /** Who asked for this task: the developer, or the agent that delegated it. */
  requestedBy?: string;
  /** The task's own Git worktree, when it has one (`agentbrain worktree add`). */
  worktree?: { path: string; branch: string; base: string };
}

export interface ReviewVote {
  agent: string;
  verdict: "approved" | "changes";
  notes?: string;
  at: string;
}

/** A command AgentBrain ran itself in the task's folder: evidence no agent can fake. */
export interface ReviewCheck {
  command: string;
  ok: boolean;
  exitCode: number | null;
  tail: string;
  ms: number;
  at: string;
}

/** Something an agent said that the evidence contradicts. */
export interface ReviewFlag {
  agent: string;
  kind: "no-change" | "false-claim" | "hallucination" | "dissent";
  text: string;
  at: string;
}

export interface ReviewState {
  worker: string;
  requestedAt: string;
  votes?: ReviewVote[];
  checks?: ReviewCheck[];
  flags?: ReviewFlag[];
  verifiedAt?: string;
  /** Claude Code sessions already asked to review this submission. */
  nudged?: string[];
}

export interface ReviewVerdict {
  verdict: "approved" | "changes";
  /** "consensus", or who overrode it. */
  reviewer: string;
  worker?: string;
  notes?: string;
  votes?: ReviewVote[];
  checks?: ReviewCheck[];
  flags?: ReviewFlag[];
  at: string;
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
  /** Set for `run --headless` sessions, so live views can find and talk to them. */
  mode?: "headless";
  pid?: number;
  transcript?: string;
  /** Last time the agent was seen doing something (hooks, MCP calls). */
  lastSeenAt?: string;
  /** What an interactive session is doing now, as reported by its hooks. */
  activity?: "working" | "idle";
  /** Last thing the session did, for the control room. */
  lastAction?: string;
}
