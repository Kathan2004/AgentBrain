import { describe, expect, it } from "vitest";
import { recordActivity } from "../src/core/activity.js";
import { createTask, takeOver } from "../src/core/actions.js";
import { rescueStalledChats } from "../src/core/rescue.js";
import { getTask, initStore } from "../src/core/store.js";
import { tempRepo } from "./helpers.js";

const self = { command: "true", args: [] as string[] };

describe("chat autopilot", () => {
  it("hands on a chat agent's task after 20 minutes without any sign of life", () => {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    const task = createTask(repo, "Add a greeting");
    takeOver(repo, task.id, { id: "vscode", sessionId: "v1" });
    expect(rescueStalledChats(repo, self, new Date(Date.now() + 5 * 60_000))).toEqual([]);
    expect(getTask(repo, task.id).status).toBe("running");

    rescueStalledChats(repo, self, new Date(Date.now() + 25 * 60_000));
    expect(getTask(repo, task.id).status).toBe("handoff");
  });

  it("leaves a chat alone while it is still calling tools", () => {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    const task = createTask(repo, "Add a greeting");
    takeOver(repo, task.id, { id: "vscode", sessionId: "v1" });
    const later = new Date(Date.now() + 25 * 60_000);
    recordActivity(repo, { agent: "vscode", task: task.id, kind: "tool", text: "Read src/a.ts", at: new Date(later.getTime() - 60_000).toISOString() } as never);
    rescueStalledChats(repo, self, later);
    expect(getTask(repo, task.id).status).toBe("running");
  });
});
