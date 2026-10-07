import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, ab, readJson, stubAgent, tempRepo } from "./helpers.js";

const FAKE = path.resolve("tests/fixtures/fake-acp-agent.mjs");

function setup() {
  const repo = tempRepo("agentbrain-acp-");
  const bin = path.join(repo, "..", path.basename(repo) + "-bin");
  stubAgent(bin, "agentbrain", `exec node ${JSON.stringify(CLI)} "$@"`);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  ab(repo, ["init"], env);
  ab(repo, ["task", "create", "Add the feature constant"], env);
  const taskId = readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId as string;
  const reportFile = `${repo}-report.json`;
  const run = (extra: string[] = [], fakeEnv: Record<string, string> = {}) =>
    spawnSync("node", [CLI, "run", "--headless", "--agent", "fake", ...extra, "--", "node", FAKE], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env, FAKE_REPORT: reportFile, ...fakeEnv },
      timeout: 60_000,
    });
  const task = () => readJson(path.join(repo, ".agentbrain/tasks", taskId, "task.json"));
  const report = () => readJson(reportFile);
  return { repo, taskId, run, task, report };
}

describe("headless ACP runs", () => {
  it("drives an ACP agent end to end in the task's own worktree", () => {
    const { repo, run, task, report } = setup();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("task is review");

    const t = task();
    expect(t).toMatchObject({ status: "review", agent: { id: "fake" } });
    expect(t.completed).toContain("Add the feature constant");
    expect(t.decisions).toContain("Exported a constant to keep the feature minimal");

    // Isolated: the work landed in the task's worktree, not the main checkout.
    const wt = fs.realpathSync(t.worktree.path);
    expect(fs.readFileSync(path.join(wt, "feature.ts"), "utf8")).toBe("export const feature = 1;\n");
    expect(fs.existsSync(path.join(repo, "feature.ts"))).toBe(false);

    const r = report();
    expect(r.initialize.clientCapabilities.fs).toEqual({ readTextFile: true, writeTextFile: true });
    expect(fs.realpathSync(r.session.cwd)).toBe(wt);
    expect(r.session.mcpServers[0].args).toEqual(expect.arrayContaining(["mcp", "--agent", "fake"]));
    // The agent got the task from both the prompt and AgentBrain's MCP server.
    expect(r.prompts[0]).toContain("Add the feature constant");
    expect(r.prompts[0]).toContain("You are running headless");
    expect(r.mcp.brief).toContain("Add the feature constant");
    expect(r.mcp.update).toContain("is review");
    // File access is confined to the worktree; shell commands are refused by default.
    expect(r.fs.read).toBe("demo\n");
    expect(r.fs.escape.error.message).toContain("outside the task's working directory");
    expect(fs.existsSync(path.join(wt, "..", "escaped.txt"))).toBe(false);
    expect(r.permissions.execute.outcome.optionId).toBe("no");
    expect(r.permissions.edit.outcome.optionId).toBe("yes");

    const sessions = path.join(repo, ".agentbrain/agents/fake/sessions");
    const log = fs.readFileSync(path.join(sessions, fs.readdirSync(sessions).find((f) => f.endsWith(".log"))!), "utf8");
    expect(log).toContain("rejected execute: rm -rf build");
    expect(log).toContain("wrote feature.ts");
  });

  it("allows more tool kinds with --allow", () => {
    const { run, report } = setup();
    expect(run(["--allow", "read,edit,execute"]).status).toBe(0);
    expect(report().permissions.execute.outcome.optionId).toBe("yes");
  });

  it("keeps prompting while the agent makes progress, then hands off if unfinished", () => {
    const { run, task, report } = setup();
    const result = run(["--max-turns", "2"], { FAKE_STATUS: "running" });
    expect(result.status).toBe(1);
    expect(report().prompts).toHaveLength(2);
    expect(report().prompts[1].startsWith("continue")).toBe(true);
    const t = task();
    expect(t.status).toBe("handoff");
    expect(t.completed).toContain("Add the feature constant");
  });

  it("hands off with the reason when the agent crashes", () => {
    const { run, task } = setup();
    const result = run([], { FAKE_MODE: "crash" });
    expect(result.status).toBe(1);
    expect(task().status).toBe("handoff");
    expect(result.stderr).toMatch(/stop reason: error: agent exited \(code 2\)/);
  });

  it("cancels a run that exceeds --timeout", () => {
    const { run, task, report } = setup();
    const result = run(["--timeout", "0.05"], { FAKE_MODE: "hang" });
    expect(result.stderr).toContain("timed out after 0.05 min");
    expect(report().cancelled).toBe(true);
    expect(task().status).toBe("handoff");
  });

  it("refuses unknown agents and tool kinds", () => {
    const { repo } = setup();
    expect(() => ab(repo, ["run", "aider", "--headless"])).toThrow("has no ACP adapter");
    expect(() => ab(repo, ["run", "--headless", "--allow", "everything", "--", "node", FAKE])).toThrow("Unknown tool kind");
  });
});
