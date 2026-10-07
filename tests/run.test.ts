import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CLI, ab, activeTask, readJson, stubAgent, tempRepo } from "./helpers.js";

/**
 * Exercises `agentbrain run` with stub agents standing in for the real CLIs:
 * same command names, same argv convention, and they talk back to AgentBrain
 * the way the prompt instructs a real agent to.
 */
describe("agentbrain run", () => {
  let repo: string;
  let bin: string;
  let env: Record<string, string>;

  beforeEach(() => {
    repo = tempRepo("agentbrain-run-");
    bin = path.join(repo, "..", path.basename(repo) + "-bin");
    // Put `agentbrain` itself on PATH for the stubs, like `npm link` would.
    stubAgent(bin, "agentbrain", `exec node ${JSON.stringify(CLI)} "$@"`);
    env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    ab(repo, ["init"], env);
    ab(repo, ["task", "create", "Implement OAuth login"], env);
  });

  it("auto-hands off when the agent exits without doing so (e.g. usage limit)", () => {
    // "Claude" records progress, edits code, then dies mid-task.
    stubAgent(bin, "claude", `
      printf '%s' "$1" > "$AGENTBRAIN_ROOT/../$(basename "$AGENTBRAIN_ROOT")-claude-prompt.txt"
      echo 'export const callback = 1;' > oauth.ts
      agentbrain task update --done "OAuth callback" --todo "Refresh-token rotation" \\
        --decision "httpOnly cookies" --next "Implement refresh-token rotation"
      exit 3`);

    const result = spawnSync("node", [CLI, "run", "claude"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Auto-handoff");

    const prompt = fs.readFileSync(`${repo}-claude-prompt.txt`, "utf8");
    expect(prompt).toContain("You are starting a software task");
    expect(prompt).toContain("Implement OAuth login");
    expect(prompt).toContain("agentbrain task update --done");

    const task = activeTask(repo);
    expect(task.status).toBe("handoff");
    expect(task.agent.id).toBe("claude-code");
    expect(task.completed).toContain("OAuth callback");

    const cpDir = path.join(repo, ".agentbrain/tasks", task.id, "checkpoints");
    const [cpFile] = fs.readdirSync(cpDir).filter((f) => f.endsWith(".json"));
    const cp = readJson(path.join(cpDir, cpFile));
    expect(cp.stopReason).toBe("claude-code exited with code 3");
    expect(cp.git.changedFiles).toEqual(["oauth.ts"]);

    const session = readJson(
      path.join(repo, ".agentbrain/agents/claude-code/sessions", `${task.agent.sessionId}.json`),
    );
    expect(session).toMatchObject({ stopReason: "claude-code exited with code 3", checkpointId: cp.checkpointId });

    // Codex picks up and sees what Claude did — then hands off itself.
    stubAgent(bin, "codex", `
      printf '%s' "$1" > "$AGENTBRAIN_ROOT/../$(basename "$AGENTBRAIN_ROOT")-codex-prompt.txt"
      agentbrain task update --done "Refresh-token rotation" --next "Write tests"
      agentbrain handoff --reason "switching to review"`);

    const second = spawnSync("node", [CLI, "run", "codex"], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    expect(second.status).toBe(0);
    expect(second.stderr).toContain("taking over from claude-code");
    expect(second.stderr).not.toContain("Auto-handoff");

    const codexPrompt = fs.readFileSync(`${repo}-codex-prompt.txt`, "utf8");
    expect(codexPrompt).toContain("You are continuing a software task");
    expect(codexPrompt).toContain("Last agent: claude-code");
    expect(codexPrompt).toContain("Stop reason: claude-code exited with code 3");
    expect(codexPrompt).toContain("- OAuth callback");
    expect(codexPrompt).toContain("- oauth.ts");
    expect(codexPrompt).toContain("Implement refresh-token rotation");

    const after = activeTask(repo);
    expect(after.status).toBe("handoff");
    expect(after.agent.id).toBe("codex");
    expect(after.completed).toEqual(["OAuth callback", "Refresh-token rotation"]);
    const codexSession = readJson(
      path.join(repo, ".agentbrain/agents/codex/sessions", `${after.agent.sessionId}.json`),
    );
    expect(codexSession.stopReason).toBe("switching to review");
    expect(codexSession.endedAt).toBeTruthy();
  });

  it("runs any command via -- with {prompt_file}", () => {
    stubAgent(bin, "my-agent", `cp "$1" "$AGENTBRAIN_ROOT/../$(basename "$AGENTBRAIN_ROOT")-custom.txt"
      agentbrain task update --status review --next "Review"`);
    ab(repo, ["run", "--agent", "mine", "--", "my-agent", "{prompt_file}"], env);
    expect(fs.readFileSync(`${repo}-custom.txt`, "utf8")).toContain("Implement OAuth login");
    const task = activeTask(repo);
    expect(task).toMatchObject({ status: "review", agent: { id: "mine" } });
  });

  it("clears a next action once it is completed", () => {
    ab(repo, ["task", "update", "--todo", "Add tests", "--next", "Add tests"], env);
    ab(repo, ["task", "update", "--done", "Add tests"], env);
    expect(activeTask(repo).nextAction).toBeUndefined();
  });

  it("refuses unknown or missing agents without touching the task", () => {
    expect(() => ab(repo, ["run", "vim"], env)).toThrow('Unknown agent "vim"');
    const noGemini = `${bin}${path.delimiter}${path.dirname(process.execPath)}`;
    expect(() => ab(repo, ["run", "gemini"], { PATH: noGemini })).toThrow("not found on PATH");
    expect(activeTask(repo).status).toBe("idle");
  });
});

describe("state safety", () => {
  it("handoff never modifies the working tree or index", () => {
    const repo = tempRepo("agentbrain-safe-");
    fs.writeFileSync(path.join(repo, "README.md"), "edited\n");
    fs.writeFileSync(path.join(repo, "new.ts"), "x\n");
    execFileSync("git", ["add", "new.ts"], { cwd: repo });
    const snapshot = () => [
      execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }),
      execFileSync("git", ["diff"], { cwd: repo, encoding: "utf8" }),
      execFileSync("git", ["diff", "--cached"], { cwd: repo, encoding: "utf8" }),
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }),
    ];
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "x"]);
    const before = snapshot().map((s) => s.replace(/\?\? \.agentbrain\/\n/, ""));
    ab(repo, ["checkpoint"]);
    ab(repo, ["handoff"]);
    const after = snapshot().map((s) => s.replace(/\?\? \.agentbrain\/\n/, ""));
    expect(after).toEqual(before);
  });

  it("never writes secrets to state", () => {
    const repo = tempRepo("agentbrain-secret-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Rotate key sk-ant-api03-abcdefghijklmnopqrstuvwx"]);
    ab(repo, ["task", "update", "--decision", "DB_PASSWORD=hunter2hunter2", "--next", "use ghp_abcdefghijklmnopqrstuvwxyz0123456789"]);
    ab(repo, ["handoff", "--reason", "token=abcdef123456"]);
    const grep = spawnSync("grep", ["-r", "-E", "sk-ant|hunter2|ghp_|abcdef123456", ".agentbrain"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(grep.stdout).toBe("");
    expect(grep.status).toBe(1); // 1 = no matches
    expect(fs.readFileSync(path.join(repo, ".agentbrain/project.json"), "utf8")).toBeTruthy();
    expect(activeTask(repo).decisions).toEqual(["DB_PASSWORD=[REDACTED]"]);
  });
});
