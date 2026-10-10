import { readActivity, recordActivity } from "./activity.js";
import { updateTask } from "./actions.js";
import { autoContinue, rankWorkers } from "./delegate.js";
import { taskActivity } from "./stall.js";
import { CONFLICT_PREFIX, isReviewer } from "./review.js";
import type { TaskState } from "./state.js";
import { getTask, listTasks, saveTask } from "./store.js";

/**
 * Autopilot for chats. A background run that stops is handed on by its own
 * process, but a chat agent (Copilot in VS Code) can stall silently: waiting
 * on an approval prompt, or never receiving the message. When a chat's task
 * shows no sign of life (no AgentBrain update, file edit or tool call) for
 * this long, it goes to the next agent so the work still finishes.
 */
export const CHAT_STALL_MINUTES = 20;

export function rescueStalledChats(root: string, self: { command: string; args: string[] }, now = new Date()): string[] {
  const chats = new Set(rankWorkers(root, now).filter((c) => c.worker.how === "chat").map((c) => c.worker.id));
  const since = now.getTime() - CHAT_STALL_MINUTES * 60_000;
  const recent = readActivity(root, 600).filter((e) => Date.parse(e.at) >= since);
  const rescued: string[] = [];
  for (const task of listTasks(root)) {
    const agent = task.agent?.id;
    if (task.status !== "running" || !agent || !chats.has(agent)) continue;
    // Tool calls and messages reach the feed even when the task file doesn't change.
    if (recent.some((e) => e.task === task.id && e.agent === agent)) continue;
    const activity = taskActivity(root, task, CHAT_STALL_MINUTES, now);
    if (!activity?.stalled) continue;
    const reason = `no progress in its chat for ${Math.round(activity.minutesSinceAnyActivity)} min (it may be waiting for an approval)`;
    updateTask(root, task.id, { status: "handoff", next: `Continue: ${agent} stalled` });
    recordActivity(root, { agent: "agentbrain", task: task.id, kind: "handoff", text: `${agent} made ${reason}; handing the task on` });
    try {
      if (autoContinue(root, task.id, agent, reason, self)) rescued.push(task.id);
    } catch { /* the task stays handed off for the next agent */ }
  }
  return rescued;
}

/**
 * The send-back event when a review returned this task (changes requested, or
 * approved but conflicting with main) and nobody has picked it up since; null
 * when the last hand-off was an agent stopping (the run's own autopilot covers that).
 */
function sentBackEvent(root: string, task: TaskState): { at: string; by: string } | null {
  const last = task.events?.at(-1);
  if (task.status !== "handoff" || last?.status !== "handoff" || !last.agent) return null;
  const review = task.reviews?.at(-1);
  const byReview = last.agent === "agentbrain" || isReviewer(root, last.agent) ||
    (review?.verdict === "changes" && review.at <= last.at && last.agent !== review.worker);
  return byReview ? { at: last.at, by: last.agent } : null;
}

/**
 * Autopilot for sent-back work: a task a review returned goes back to an
 * agent, the one that did it first when it can (it knows the code). Once per
 * send-back: if nobody is ready, it waits for the developer.
 */
export function resumeSentBack(root: string, self: { command: string; args: string[] }, now = new Date()): string[] {
  const resumed: string[] = [];
  for (const task of listTasks(root)) {
    const sent = sentBackEvent(root, task);
    if (!sent || task.sentBackResumed === sent.at || Date.parse(sent.at) > now.getTime()) continue;
    const fresh = getTask(root, task.id);
    fresh.sentBackResumed = sent.at;
    saveTask(root, fresh);
    const review = task.reviews?.at(-1);
    const conflict = task.remaining.find((r) => r.startsWith(CONFLICT_PREFIX));
    const reason = conflict ?? (review?.notes ?? task.nextAction ?? "changes requested").split("\n")[0];
    const worker = conflict ? task.agent?.id : review?.worker ?? task.agent?.id;
    try {
      if (autoContinue(root, task.id, sent.by, reason, self, { prefer: worker, sentBack: true })) resumed.push(task.id);
    } catch { /* the task stays handed off for the next agent */ }
  }
  return resumed;
}
