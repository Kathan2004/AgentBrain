import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, ab, readJson, stubAgent, tempRepo } from "./helpers.js";

function taskJson(repo: string, id: string) {
  return readJson(path.join(repo, ".agentbrain/tasks", id, "task.json"));
}

function createTask(repo: string, objective: string, worktree: boolean, env: Record<string, string> = {}) {
  ab(repo, ["task", "create", objective, ...(worktree ? ["--worktree"] : [])], env);
  return readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId as string;
}

describe("task worktrees", () => {
  it("gives each task its own checkout and branch, sharing one AgentBrain state", () => {
    const repo = tempRepo("agentbrain-wt-");
    ab(repo, ["init"]);
    const a = createTask(repo, "Build login", true);
    const b = createTask(repo, "Build logout", true);

    const wtA = taskJson(repo, a).worktree;
    const wtB = taskJson(repo, b).worktree;
    expect(wtA.branch).toBe(`agentbrain/${a}`);
    expect(fs.existsSync(path.join(wtA.path, "README.md"))).toBe(true);
    expect(wtA.path).not.toBe(wtB.path);
    // Worktrees don't show up as changes in the main checkout.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("?? .agentbrain/\n");

    // Two agents edit in parallel; each task sees only its own changes.
    fs.writeFileSync(path.join(wtA.path, "login.ts"), "x\n");
    fs.writeFileSync(path.join(wtB.path, "logout.ts"), "y\n");

    // Commands run inside a worktree apply to that worktree's task, whatever is active.
    ab(wtA.path, ["task", "update", "--agent", "copilot", "--session", "p1", "--done", "1"]);
    ab(wtA.path, ["handoff", "--reason", "switching"]);
    expect(taskJson(repo, a)).toMatchObject({ status: "handoff", agent: { id: "copilot" } });
    expect(taskJson(repo, b).status).toBe("idle");

    const brief = ab(wtA.path, ["resume"]).stdout;
    expect(brief).toContain("Build login");
    expect(brief).toContain(`Working directory: ${wtA.path}`);
    expect(brief).toContain("- login.ts");
    expect(brief).not.toContain("logout.ts");

    const cpDir = path.join(repo, ".agentbrain/tasks", a, "checkpoints");
    const cp = readJson(path.join(cpDir, fs.readdirSync(cpDir).find((f) => f.endsWith(".json"))!));
    expect(cp.git.branch).toBe(`agentbrain/${a}`);
    expect(cp.git.changedFiles).toEqual(["login.ts"]);
  });

  it("records a commit in a worktree against that worktree's task", () => {
    const repo = tempRepo("agentbrain-wt-");
    const bin = path.join(repo, "..", path.basename(repo) + "-bin");
    stubAgent(bin, "agentbrain", `exec node ${JSON.stringify(CLI)} "$@"`);
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    ab(repo, ["init"], env);
    ab(repo, ["hooks", "install"], env);
    const a = createTask(repo, "Build login", true, env);
    createTask(repo, "Something else", false, env); // now the active task
    ab(repo, ["task", "update", "--task", a, "--agent", "copilot", "--session", "p1", "--next", "commit"], env);

    const wt = taskJson(repo, a).worktree.path;
    fs.writeFileSync(path.join(wt, "login.ts"), "x\n");
    execFileSync("git", ["add", "login.ts"], { cwd: wt, env: { ...process.env, ...env } });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add login"], {
      cwd: wt,
      env: { ...process.env, ...env },
    });
    const cpDir = path.join(repo, ".agentbrain/tasks", a, "checkpoints");
    const reasons = fs.readdirSync(cpDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(cpDir, f)).stopReason);
    expect(reasons.some((r: string) => /^commit \w+: add login$/.test(r))).toBe(true);

    // A commit in the main checkout does not belong to a task that has its own worktree,
    // even when that task is the active one.
    ab(repo, ["task", "use", a], env);
    fs.writeFileSync(path.join(repo, "main-only.ts"), "x\n");
    execFileSync("git", ["add", "main-only.ts"], { cwd: repo, env: { ...process.env, ...env } });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main checkout work"], {
      cwd: repo,
      env: { ...process.env, ...env },
    });
    const after = fs.readdirSync(cpDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(cpDir, f)).stopReason);
    expect(after.some((r: string) => /main checkout work/.test(r))).toBe(false);
  });

  it("launches agents inside the task's worktree", () => {
    const repo = tempRepo("agentbrain-wt-");
    const bin = path.join(repo, "..", path.basename(repo) + "-bin2");
    stubAgent(bin, "claude", `pwd > "$AGENTBRAIN_PROMPT_FILE.cwd"`);
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    ab(repo, ["init"], env);
    const a = createTask(repo, "Build login", true, env);
    const result = spawnSync("node", [CLI, "run", "claude", a], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    expect(result.status).toBe(0);
    const sessions = path.join(repo, ".agentbrain/agents/claude-code/sessions");
    const cwdFile = fs.readdirSync(sessions).find((f) => f.endsWith(".cwd"))!;
    expect(fs.realpathSync(fs.readFileSync(path.join(sessions, cwdFile), "utf8").trim())).toBe(
      fs.realpathSync(taskJson(repo, a).worktree.path),
    );
  });

  it("removes a worktree only when it is clean, and keeps the branch", () => {
    const repo = tempRepo("agentbrain-wt-");
    ab(repo, ["init"]);
    const a = createTask(repo, "Build login", true);
    const wt = taskJson(repo, a).worktree.path;
    fs.writeFileSync(path.join(wt, "wip.ts"), "x\n");
    expect(() => ab(repo, ["worktree", "remove", a])).toThrow("uncommitted changes");

    execFileSync("git", ["add", "-A"], { cwd: wt });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "wip"], { cwd: wt });
    const out = ab(repo, ["worktree", "remove", a]).stdout;
    expect(out).toContain("1 commit(s) not merged yet");
    expect(fs.existsSync(wt)).toBe(false);
    expect(taskJson(repo, a).worktree).toBeUndefined();
    expect(execFileSync("git", ["branch", "--list", `agentbrain/${a}`], { cwd: repo, encoding: "utf8" })).toContain(a);
  });

  it("merges a finished task's branch and removes its worktree; reports conflicts", () => {
    const repo = tempRepo("agentbrain-wt-");
    ab(repo, ["init"]);
    const a = createTask(repo, "Build login", true);
    const wt = taskJson(repo, a).worktree.path;
    const commit = (cwd: string, file: string, text: string, msg: string) => {
      fs.writeFileSync(path.join(cwd, file), text);
      execFileSync("git", ["add", "-A"], { cwd });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], { cwd });
    };
    commit(wt, "login.ts", "login\n", "add login");
    const out = ab(repo, ["worktree", "merge", a]).stdout;
    expect(out).toContain("Merged 1 commit(s)");
    expect(fs.readFileSync(path.join(repo, "login.ts"), "utf8")).toBe("login\n");
    expect(fs.existsSync(wt)).toBe(false);

    const b = createTask(repo, "Edit README", true);
    const wtB = taskJson(repo, b).worktree.path;
    commit(wtB, "README.md", "from task\n", "task edit");
    commit(repo, "README.md", "from main\n", "main edit");
    const result = spawnSync("node", [CLI, "worktree", "merge", b], { cwd: repo, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("- README.md");
    expect(fs.existsSync(wtB)).toBe(true);
    execFileSync("git", ["merge", "--abort"], { cwd: repo });
  });

  it("lists the task's commits in the brief", () => {
    const repo = tempRepo("agentbrain-wt-");
    ab(repo, ["init"]);
    const a = createTask(repo, "Build login", true);
    const wt = taskJson(repo, a).worktree.path;
    for (const [file, msg] of [["a.ts", "Add login form"], ["b.ts", "Validate passwords"]]) {
      fs.writeFileSync(path.join(wt, file), "x\n");
      execFileSync("git", ["add", "-A"], { cwd: wt });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], { cwd: wt });
    }
    const brief = ab(repo, ["resume", a]).stdout;
    expect(brief).toContain("## Commits on this task (newest first)");
    expect(brief).toMatch(/- \w+ Validate passwords\n- \w+ Add login form/);
  });

  it("prunes only finished, merged, clean worktrees", () => {
    const repo = tempRepo("agentbrain-wt-");
    ab(repo, ["init"]);
    const commitIn = (cwd: string, file: string) => {
      fs.writeFileSync(path.join(cwd, file), "x\n");
      execFileSync("git", ["add", "-A"], { cwd });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file], { cwd });
    };
    const done = createTask(repo, "Merged and done", true);
    commitIn(taskJson(repo, done).worktree.path, "done.ts");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "m", `agentbrain/${done}`], { cwd: repo });
    ab(repo, ["task", "update", "--task", done, "--status", "done"]);
    const open = createTask(repo, "Still running", true);
    const unmerged = createTask(repo, "Done but unmerged", true);
    commitIn(taskJson(repo, unmerged).worktree.path, "u.ts");
    ab(repo, ["task", "update", "--task", unmerged, "--status", "done"]);

    const dry = ab(repo, ["worktree", "prune", "--branches", "--dry-run"]).stdout;
    expect(dry).toContain(`would remove 1 worktree(s): ${done}`);
    expect(fs.existsSync(taskJson(repo, done).worktree.path)).toBe(true);

    const out = ab(repo, ["worktree", "prune", "--branches"]).stdout;
    expect(out).toContain(`removed 1 worktree(s): ${done}`);
    expect(out).toContain("deleted 1 merged branch(es)");
    expect(out).toContain(`kept ${open}: task is idle`);
    expect(out).toContain(`kept ${unmerged}: agentbrain/${unmerged} has unmerged commits`);
    expect(taskJson(repo, done).worktree).toBeUndefined();
    expect(fs.existsSync(taskJson(repo, open).worktree.path)).toBe(true);
    const branches = execFileSync("git", ["branch", "--list", "agentbrain/*"], { cwd: repo, encoding: "utf8" });
    expect(branches).not.toContain(done);
    expect(branches).toContain(unmerged);
  });
});
