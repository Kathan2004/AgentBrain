import { execFileSync } from "node:child_process";
import { snapshot, watchProject, type Snapshot } from "../ui/model.js";

export type NotificationSender = (title: string, message: string) => void;

const NOTIFY_STATUSES = new Set(["review", "done", "blocked", "failed", "handoff"]);

/** Send a desktop notification, or print it when desktop notifications are unavailable. */
export function defaultNotificationSender(print = false): NotificationSender {
  return (title, message) => {
    if (!print && process.platform === "darwin") {
      try {
        execFileSync("osascript", [
          "-e",
          `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
        ], { stdio: "ignore" });
        return;
      } catch {
        // Fall through to stdout if osascript is unavailable.
      }
    }
    console.log(`${title}: ${message}`);
  };
}

function taskKey(task: Snapshot["tasks"][number]): string {
  return `${task.status}\0${task.warning ?? ""}`;
}

/** Watch task state and notify once for each settlement or newly appearing stall warning. */
export function watchNotifications(root: string, send: NotificationSender): () => void {
  const previous = new Map<string, string>();
  let initialized = false;

  const check = () => {
    const current = snapshot(root);
    for (const task of current.tasks) {
      const oldKey = previous.get(task.id);
      const key = taskKey(task);
      if (initialized && oldKey !== undefined) {
        const [oldStatus, oldWarning] = oldKey.split("\0");
        if (oldStatus !== task.status && NOTIFY_STATUSES.has(task.status)) {
          send(`Task ${task.status}: ${task.id}`, task.objective);
        } else if (!oldWarning && task.warning) {
          send(`Task stalled: ${task.id}`, task.warning);
        }
      }
      previous.set(task.id, key);
    }
    initialized = true;
  };

  check();
  return watchProject(root, check);
}