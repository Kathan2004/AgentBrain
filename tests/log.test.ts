import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ab, tempRepo } from "./helpers.js";

describe("agentbrain log", () => {
  it("shows sessions and checkpoints in chronological order", () => {
    const repo = tempRepo("agentbrain-log-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Track the agent timeline"]);
    ab(repo, ["task", "update", "--agent", "alpha", "--session", "s-alpha", "--done", "1"]);
    ab(repo, ["checkpoint", "--agent", "alpha", "--session", "s-alpha", "--reason", "progress saved"]);
    ab(repo, ["handoff", "--agent", "alpha", "--session", "s-alpha", "--reason", "switching agents"]);
    ab(repo, ["task", "update", "--agent", "beta", "--session", "s-beta", "--todo", "Review timeline"]);
    ab(repo, ["handoff", "--agent", "beta", "--session", "s-beta", "--reason", "finished review"]);

    const lines = ab(repo, ["log"]).stdout.trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => line.trim().split(/\s+/)[3])).toEqual([
      "start",
      "checkpoint",
      "handoff",
      "start",
      "handoff",
    ]);
    expect(lines[1]).toContain("progress saved");
    expect(lines[2]).toContain("switching agents");
    expect(lines[4]).toContain("finished review");
  });

  it("keeps a session that moved between tasks in each task's timeline", () => {
    const repo = tempRepo("agentbrain-log-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "First"]);
    const first = JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain/project.json"), "utf8")).activeTaskId;
    ab(repo, ["task", "update", "--agent", "vscode", "--session", "mcp-1", "--done", "1"]);
    ab(repo, ["task", "create", "Second"]);
    const second = JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain/project.json"), "utf8")).activeTaskId;
    ab(repo, ["task", "update", "--task", second, "--agent", "vscode", "--session", "mcp-1", "--todo", "Write it"]);
    expect(ab(repo, ["log", first]).stdout).toContain("session mcp-1");
    expect(ab(repo, ["log"]).stdout).toContain("session mcp-1");
  });
});