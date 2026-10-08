import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { initStore } from "../src/core/store.js";
import { watchNotifications } from "../src/core/notify.js";
import { tempRepo } from "./helpers.js";

/** Waits until `check` passes (file watching is slower on busy CI machines), up to 10 s. */
async function eventually(check: () => boolean): Promise<void> {
  const until = Date.now() + 10_000;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

describe("task notifications", () => {
  it("notifies once when a task moves to review", async () => {
    const repo = tempRepo("agentbrain-notify-");
    initStore(repo);
    const task = createTask(repo, "Review the change");
    const sent: [string, string][] = [];
    const stop = watchNotifications(repo, (title, message) => sent.push([title, message]));
    try {
      updateTask(repo, task.id, { status: "review" });
      await eventually(() => sent.length > 0);
      expect(sent).toEqual([[`Task review: ${task.id}`, task.objective]]);

      // Nothing changes from here: no repeat notification, even across a poll.
      await new Promise((r) => setTimeout(r, 3500));
      expect(sent).toHaveLength(1);
    } finally {
      stop();
    }
  });
});