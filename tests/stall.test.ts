import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../src/core/store.js";
import { describeActivity, taskActivity } from "../src/core/stall.js";
import { ab, activeTask, readJson, tempRepo } from "./helpers.js";

const MIN = 60_000;

/** A running task owned by copilot, with AgentBrain last updated `minutesAgo`. */
function runningTask(minutesAgo: number) {
  const repo = tempRepo("agentbrain-stall-");
  ab(repo, ["init"]);
  ab(repo, ["task", "create", "Build doctor"]);
  ab(repo, ["task", "update", "--agent", "copilot", "--session", "p1", "--next", "Write doctor.ts"]);
  const file = path.join(repo, ".agentbrain/tasks", activeTask(repo).id, "task.json");
  const task = readJson(file);
  task.updatedAt = new Date(Date.now() - minutesAgo * MIN).toISOString();
  fs.writeFileSync(file, JSON.stringify(task));
  return { repo, taskId: task.id as string };
}

function touch(repo: string, file: string, minutesAgo: number) {
  const full = path.join(repo, file);
  fs.writeFileSync(full, "x\n");
  const time = new Date(Date.now() - minutesAgo * MIN);
  fs.utimesSync(full, time, time);
}

describe("stall detection", () => {
  it("is quiet while the agent is recording progress", () => {
    const { repo, taskId } = runningTask(2);
    expect(describeActivity(taskActivity(repo, getTask(repo, taskId)))).toBeNull();
  });

  it("flags an agent with no activity at all (stopped, or stuck on an approval prompt)", () => {
    const { repo, taskId } = runningTask(25);
    touch(repo, "doctor.ts", 15);
    const activity = taskActivity(repo, getTask(repo, taskId))!;
    expect(activity).toMatchObject({ stalled: true, unrecorded: false, minutesSinceAnyActivity: 15 });
    expect(describeActivity(activity)).toContain("copilot has shown no activity for 15 min");

    const status = ab(repo, ["status"]).stdout;
    expect(status).toContain("⚠ copilot has shown no activity for 15 min");
    expect(status).toContain("take over");
    // Whoever picks the task up is told, too.
    expect(ab(repo, ["resume"]).stdout).toContain("> Note: copilot has shown no activity");
  });

  it("flags an agent that keeps editing files without recording progress", () => {
    const { repo, taskId } = runningTask(30);
    touch(repo, "doctor.ts", 1);
    const activity = taskActivity(repo, getTask(repo, taskId))!;
    expect(activity).toMatchObject({ stalled: false, unrecorded: true, minutesSinceRecorded: 30 });
    expect(describeActivity(activity)).toContain("hasn't recorded progress in AgentBrain for 30 min");
  });

  it("respects stallMinutes in project.json and ignores tasks that aren't running", () => {
    const { repo, taskId } = runningTask(25);
    const projectFile = path.join(repo, ".agentbrain/project.json");
    fs.writeFileSync(projectFile, JSON.stringify({ ...readJson(projectFile), stallMinutes: 60 }));
    expect(ab(repo, ["status"]).stdout).not.toContain("⚠");

    ab(repo, ["task", "update", "--status", "review"]);
    expect(taskActivity(repo, getTask(repo, taskId), 1)).toBeNull();
  });

  it("notices unclaimed work on a handed-off task", () => {
    const { repo, taskId } = runningTask(1);
    ab(repo, ["handoff", "--reason", "switching"]);
    const handedOff = getTask(repo, taskId);
    touch(repo, "doctor.ts", 0);
    // mtimes have 1s resolution on some filesystems; make sure the edit is after the handoff
    const later = new Date(new Date(handedOff.updatedAt!).getTime() + 2000);
    fs.utimesSync(path.join(repo, "doctor.ts"), later, later);
    const activity = taskActivity(repo, getTask(repo, taskId))!;
    expect(activity.unclaimed).toBe(true);
    expect(describeActivity(activity)).toContain("no agent has taken it over");
  });
});
