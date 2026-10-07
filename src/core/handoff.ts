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

/**
 * After many agent switches the history gets long; the brief keeps the most
 * recent items (the checkpoint JSON keeps everything).
 */
function recent(items: string[], max: number, where: string): string {
  if (items.length <= max) return list(items);
  const hidden = items.length - max;
  return `- (${hidden} earlier item${hidden === 1 ? "" : "s"} in ${where})\n${list(items.slice(-max))}`;
}

export const BRIEF_LIMITS = { completed: 12, decisions: 15, changedFiles: 40 };

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
${recent(checkpoint.progress.completed, BRIEF_LIMITS.completed, "task.json")}

### Remaining
${checkpoint.progress.remaining.length ? checkpoint.progress.remaining.map((x, i) => `${i + 1}. ${x}`).join("\n") : "- None recorded"}

## Decisions
${recent(checkpoint.decisions, BRIEF_LIMITS.decisions, "task.json")}

## Known Failures
${checkpoint.failures.length ? checkpoint.failures.map((x, i) => `${i + 1}. ${x}`).join("\n") : "- None recorded"}

## Blockers
${list(checkpoint.blockers)}

## Git State
- Branch: ${checkpoint.git.branch || "(detached HEAD)"}
- HEAD: ${checkpoint.git.head ?? "(no commits yet)"}
- Working tree dirty: ${checkpoint.git.dirty ? "yes" : "no"}

### Changed Files
${checkpoint.git.changedFiles.length ? recent(checkpoint.git.changedFiles, BRIEF_LIMITS.changedFiles, "git status") : "- None"}

## Next Action
${checkpoint.nextAction}

## Continuation Instruction

Continue the task from the current repository state. Do not repeat completed work. Inspect the listed files and verify the current implementation before making changes.
`;
}
