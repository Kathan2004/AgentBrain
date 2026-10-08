import { describe, expect, it } from "vitest";
import { ab, activeTask, tempRepo } from "./helpers.js";

describe("JSON CLI output", () => {
  it("prints one parseable JSON document for status, task list, log, and route", () => {
    const repo = tempRepo("agentbrain-json-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Implement JSON output"]);
    const taskId = activeTask(repo).id as string;
    ab(repo, ["task", "update", "--agent", "test-agent", "--session", "json-session"]);

    const status = JSON.parse(ab(repo, ["status", "--json"]).stdout);
    const tasks = JSON.parse(ab(repo, ["task", "list", "--json"]).stdout);
    const timeline = JSON.parse(ab(repo, ["log", taskId, "--json"]).stdout);
    const route = JSON.parse(ab(repo, ["route", taskId, "--json"]).stdout);

    expect(status.tasks.some((task: { id: string }) => task.id === taskId)).toBe(true);
    expect(tasks.some((task: { id: string }) => task.id === taskId)).toBe(true);
    expect(timeline.length).toBeGreaterThan(0);
    expect(route).toEqual(expect.any(Array));
    expect(activeTask(repo).id).toBe(taskId);
  });
});