import { briefContext } from "./actions.js";
import { taskTimeline } from "./timeline.js";

/** Render a task's current brief and timeline as a portable Markdown file. */
export function exportTask(root: string, taskId: string): string {
  const history = taskTimeline(root, taskId);
  const historyText = history.length
    ? history.map((event) => {
      const session = event.sessionId ? ` (${event.sessionId})` : "";
      return `- ${event.timestamp} ${event.agent}${session} ${event.event}: ${event.reason}`;
    }).join("\n")
    : "- No recorded history.";

  return `${briefContext(root, taskId)}

## History
${historyText}

## Instructions for the next agent
You do not have AgentBrain access. Work from this file as the complete task context.
When you finish or stop, reply with a short summary of completed steps, decisions, failures, and the next action.
`;
}