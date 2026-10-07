import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ab, tempRepo } from "./helpers.js";

function checkpointFiles(repo: string, taskId: string): string[] {
  return fs.readdirSync(path.join(repo, ".agentbrain/tasks", taskId, "checkpoints"));
}

describe("agentbrain prune", () => {
  it("keeps the newest checkpoints and protects the newest handoff", () => {
    const repo = tempRepo("agentbrain-prune-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Trim checkpoint history"]);
    const taskId = JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain/project.json"), "utf8")).activeTaskId;
    ab(repo, ["handoff", "--reason", "old handoff"]);
    const checkpointDir = path.join(repo, ".agentbrain/tasks", taskId, "checkpoints");
    const handoffFile = fs.readdirSync(checkpointDir).find((file) => file.endsWith(".json"))!;
    const handoff = JSON.parse(fs.readFileSync(path.join(checkpointDir, handoffFile), "utf8"));
    const firstId = Number(handoff.checkpointId.slice(3));
    for (let index = 1; index < 25; index++) {
      const checkpoint = { ...handoff, checkpointId: `cp-${firstId + index}`, status: "checkpoint" };
      fs.writeFileSync(path.join(checkpointDir, `${checkpoint.checkpointId}.json`), JSON.stringify(checkpoint));
      fs.writeFileSync(path.join(checkpointDir, `${checkpoint.checkpointId}.md`), "checkpoint\n");
    }

    const before = checkpointFiles(repo, taskId);
    expect(before.filter((file) => file.endsWith(".json"))).toHaveLength(25);

    const result = ab(repo, ["prune", taskId, "--keep", "20"]);
    expect(result.stdout).toContain(`${taskId}: deleted 4 checkpoints (kept 21)`);

    const after = checkpointFiles(repo, taskId);
    expect(after.filter((file) => file.endsWith(".json"))).toHaveLength(21);
    expect(after.filter((file) => file.endsWith(".md"))).toHaveLength(21);
    expect(after.some((file) => file.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain/tasks", taskId, "checkpoints", file), "utf8")).status === "handoff")).toBe(true);
    expect(ab(repo, ["log", taskId]).stdout).toContain("handoff");
  });

  it("does not delete files during a dry run", () => {
    const repo = tempRepo("agentbrain-prune-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Preview cleanup"]);
    const taskId = JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain/project.json"), "utf8")).activeTaskId;
    ab(repo, ["checkpoint"]);
    const before = checkpointFiles(repo, taskId);

    expect(ab(repo, ["prune", taskId, "--keep", "1", "--dry-run"]).stdout).toContain("would delete");
    expect(checkpointFiles(repo, taskId)).toEqual(before);
  });
});