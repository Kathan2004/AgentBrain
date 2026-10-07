import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";

const CLI = path.resolve("dist/cli/main.js");
const schema = JSON.parse(fs.readFileSync("schemas/checkpoint.schema.json", "utf8"));

function run(cwd: string, ...args: string[]): string {
  return execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("agent A → handoff → agent B", () => {
  let repo: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error("Run `npm run build` before the CLI tests.");
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-cli-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
  });

  it("carries task, agent and git state across the switch", () => {
    run(repo, "init");
    run(repo, "task", "create", "Implement OAuth login");
    const project = readJson(path.join(repo, ".agentbrain/project.json"));
    const taskId = project.activeTaskId as string;

    // Agent A works and records progress.
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src/oauth.ts"), "export {};\n");
    run(repo, "task", "update", "--agent", "claude-code", "--session", "a1",
      "--done", "Implement OAuth login", "--done", "OAuth callback",
      "--todo", "Refresh-token rotation", "--decision", "Store tokens in httpOnly cookies",
      "--failure", "Expired token test fails", "--next", "Implement refresh-token rotation");

    // Works from a subdirectory too.
    expect(run(path.join(repo, "src"), "status")).toContain("claude-code");

    run(repo, "handoff", "--reason", "usage limit reached");

    const cpDir = path.join(repo, ".agentbrain/tasks", taskId, "checkpoints");
    const cpFile = fs.readdirSync(cpDir).find((f) => f.endsWith(".json"))!;
    const checkpoint = readJson(path.join(cpDir, cpFile));

    const ajv = new Ajv2020({ strict: true });
    addFormats.default(ajv);
    const valid = ajv.validate(schema, checkpoint);
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);

    expect(checkpoint).toMatchObject({
      taskId,
      status: "handoff",
      agent: { id: "claude-code", sessionId: "a1" },
      stopReason: "usage limit reached",
      git: { branch: "main", dirty: true, changedFiles: ["src/oauth.ts"] },
      progress: { completed: ["Implement OAuth login", "OAuth callback"], remaining: ["Refresh-token rotation"] },
      decisions: ["Store tokens in httpOnly cookies"],
      failures: ["Expired token test fails"],
      nextAction: "Implement refresh-token rotation",
    });

    const sessionA = readJson(path.join(repo, ".agentbrain/agents/claude-code/sessions/a1.json"));
    expect(sessionA).toMatchObject({ taskId, stopReason: "usage limit reached", checkpointId: checkpoint.checkpointId });
    expect(sessionA.endedAt).toBeTruthy();

    // Agent B takes over.
    const handoff = run(repo, "resume", "--agent", "codex", "--session", "b1");
    expect(handoff).toContain("Implement OAuth login");
    expect(handoff).toContain("handed off by claude-code (session a1)");
    expect(handoff).toContain("- src/oauth.ts");
    expect(handoff).toContain("Implement refresh-token rotation");

    const task = readJson(path.join(repo, ".agentbrain/tasks", taskId, "task.json"));
    expect(task).toMatchObject({ status: "running", agent: { id: "codex", sessionId: "b1" } });
    expect(fs.existsSync(path.join(repo, ".agentbrain/agents/codex/sessions/b1.json"))).toBe(true);
  });

  it("rejects unknown statuses and unsafe ids", () => {
    expect(() => run(repo, "task", "update", "--status", "nope")).toThrow();
    expect(() => run(repo, "handoff", "../../etc")).toThrow();
  });
});
