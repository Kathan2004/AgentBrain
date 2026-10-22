import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { firstOpened, runningUi, shouldAutoOpen, uiStateFile } from "../src/ui/daemon.js";
import { initStore } from "../src/core/store.js";

const CLI = path.resolve("dist/cli/main.js");
const schema = JSON.parse(fs.readFileSync("schemas/checkpoint.schema.json", "utf8"));

function run(cwd: string, ...args: string[]): string {
  // Scrub agent identity so the tests behave the same inside an `agentbrain run` session.
  const env = { ...process.env, AGENTBRAIN_AGENT: "", AGENTBRAIN_SESSION: "" };
  return execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", env });
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
    expect(handoff).toContain("Last agent: claude-code (session a1)");
    expect(handoff).toContain("Stop reason: usage limit reached");
    expect(handoff).toContain(`task update --task ${taskId} --done`);
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

describe("agentbrain wait", () => {
  it("returns at once for a task already in review", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-wait-"));
    run(repo, "init");
    run(repo, "task", "create", "Already settled");
    const project = readJson(path.join(repo, ".agentbrain/project.json"));
    const taskId = project.activeTaskId as string;
    run(repo, "task", "update", "--status", "review");

    const out = run(repo, "wait", taskId);
    expect(out).toContain(taskId);
    expect(out).toContain("review");
  });

  it("exits 2 on timeout while a task has not settled", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-wait-timeout-"));
    run(repo, "init");
    run(repo, "task", "create", "Not settled");
    const project = readJson(path.join(repo, ".agentbrain/project.json"));
    const taskId = project.activeTaskId as string;

    let status: number | null = null;
    try {
      run(repo, "wait", taskId, "--timeout", "0.01");
    } catch (error) {
      status = (error as { status: number | null }).status;
    }
    expect(status).toBe(2);
  });
});

describe("shouldAutoOpen", () => {
  it("opens in an interactive terminal outside CI, unless told not to", () => {
    expect(shouldAutoOpen(undefined, {}, true)).toBe(true);
    expect(shouldAutoOpen(undefined, { CI: "1" }, true)).toBe(false);
    expect(shouldAutoOpen(undefined, { AGENTBRAIN_NO_OPEN: "1" }, true)).toBe(false);
    expect(shouldAutoOpen(undefined, {}, false)).toBe(false);
  });

  it("opens only the first time, even after the control room stopped", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-firstopen-"));
    initStore(repo);
    expect(shouldAutoOpen(repo, {}, true)).toBe(true);
    // A control room that ran once and has exited (its pid is long gone).
    fs.writeFileSync(uiStateFile(repo), JSON.stringify({ pid: 999999, url: "http://127.0.0.1:1", startedAt: "2026-10-01T00:00:00Z", firstOpened: "2026-10-01T00:00:00Z" }));
    expect(runningUi(repo)).toBeNull();
    expect(firstOpened(repo)).toBe("2026-10-01T00:00:00Z");
    expect(shouldAutoOpen(repo, {}, true)).toBe(false);
  });
});
