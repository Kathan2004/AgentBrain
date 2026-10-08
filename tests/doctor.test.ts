import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, ab, stubAgent, tempRepo } from "./helpers.js";

describe("agentbrain doctor", () => {
  it("reports an uninitialized repository with a fix and exit code 1", () => {
    const repo = tempRepo("agentbrain-doctor-fresh-");
    const result = spawnSync("node", [CLI, "doctor"], { cwd: repo, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("✗ AgentBrain initialized");
    expect(result.stdout).toContain("fix: Run agentbrain init");
  });

  it("passes after init and connect", () => {
    const repo = tempRepo("agentbrain-doctor-ready-");
    const bin = path.join(repo, "bin");
    stubAgent(bin, "agentbrain", `exec node ${JSON.stringify(CLI)} "$@"`);
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };

    ab(repo, ["init"], env);
    ab(repo, ["connect"], env);
    const result = spawnSync("node", [CLI, "doctor"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("✗");
    expect(result.stdout).toContain("✓ MCP server  starts and answers initialize");
    expect(fs.existsSync(path.join(repo, ".git", "hooks", "post-commit"))).toBe(true);
  });

  it("reports leftover task worktrees and missing queue tasks", () => {
    const repo = tempRepo("agentbrain-doctor-state-");
    ab(repo, ["init"]);
    const done = ab(repo, ["task", "create", "Finished task", "--worktree"]).stdout
      .match(/Created (task-\d+)/)?.[1];
    expect(done).toBeDefined();
    ab(repo, ["task", "update", "--task", done!, "--status", "done"]);
    const project = JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain", "project.json"), "utf8"));
    project.queue = ["task-missing"];
    fs.writeFileSync(path.join(repo, ".agentbrain", "project.json"), JSON.stringify(project, null, 2));

    const result = spawnSync("node", [CLI, "doctor"], { cwd: repo, encoding: "utf8" });

    expect(result.stdout).toContain("✗ Task worktrees");
    expect(result.stdout).toContain("fix: Run agentbrain worktree prune");
    expect(result.stdout).toContain("✗ Queue");
    expect(result.stdout).toContain("fix: Run agentbrain queue remove task-missing");
  });
});