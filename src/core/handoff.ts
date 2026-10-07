import type { GitState } from "./git.js";
import type { AgentRef, TaskState } from "./state.js";

export interface Checkpoint {
  schemaVersion: "0.1";
  checkpointId: string;
  taskId: string;
  timestamp: string;
  status: "checkpoint" | "handoff";
  agent: AgentRef;
  stopReason?: string;
  git: GitState;
  progress: {
    completed: string[];
    remaining: string[];
  };
  decisions: string[];
  failures: string[];
  blockers: string[];
  verification: string[];
  nextAction: string;
}

export interface CheckpointOptions {
  /** Agent handing off. Defaults to the task's current agent, then "manual". */
  agent?: AgentRef;
  stopReason?: string;
  /** "handoff" (default) when the agent is stopping; "checkpoint" to snapshot mid-task. */
  status?: Checkpoint["status"];
}

export function makeCheckpoint(
  task: TaskState,
  git: GitState,
  options: CheckpointOptions = {},
): Checkpoint {
  const checkpointId = `cp-${Date.now()}`;

  return {
    schemaVersion: "0.1",
    checkpointId,
    taskId: task.id,
    timestamp: new Date().toISOString(),
    status: options.status ?? "handoff",
    agent: options.agent ?? task.agent ?? { id: "manual" },
    ...(options.stopReason ? { stopReason: options.stopReason } : {}),
    git,
    progress: {
      completed: task.completed,
      remaining: task.remaining,
    },
    decisions: task.decisions,
    failures: task.failures,
    blockers: task.blockers ?? [],
    verification: [],
    nextAction: task.nextAction ?? task.remaining[0] ?? "Review the completed work.",
  };
}

function list(items: string[], empty = "- None recorded"): string {
  return items.length ? items.map((x) => `- ${x}`).join("\n") : empty;
}

export function renderHandoff(task: TaskState, checkpoint: Checkpoint): string {
  const agent = checkpoint.agent.sessionId
    ? `${checkpoint.agent.id} (session ${checkpoint.agent.sessionId})`
    : checkpoint.agent.id;

  return `# AgentBrain Handoff

## Objective
${task.objective}

## Status
${checkpoint.status}
Last agent: ${agent}${checkpoint.stopReason ? `\nStop reason: ${checkpoint.stopReason}` : ""}

## Progress

### Completed
${list(checkpoint.progress.completed)}

### Remaining
${list(checkpoint.progress.remaining)}

## Decisions
${list(checkpoint.decisions)}

## Known Failures
${list(checkpoint.failures)}

## Blockers
${list(checkpoint.blockers)}

## Git State
- Branch: ${checkpoint.git.branch || "(detached HEAD)"}
- HEAD: ${checkpoint.git.head ?? "(no commits yet)"}
- Working tree dirty: ${checkpoint.git.dirty ? "yes" : "no"}

### Changed Files
${list(checkpoint.git.changedFiles, "- None")}

## Next Action
${checkpoint.nextAction}

## Continuation Instruction

Continue the task from the current repository state. Do not repeat completed work. Inspect the listed files and verify the current implementation before making changes.
`;
}
