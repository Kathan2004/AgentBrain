import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ab, activeTask, stubAgent, tempRepo } from "./helpers.js";

const CLI = path.resolve("dist/cli/main.js");

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

describe("Git hooks", () => {
  it("preserves an existing hook, is idempotent, and restores it on uninstall", () => {
    const repo = tempRepo();
    const hooks = path.join(repo, ".githooks");
    const hook = path.join(hooks, "post-commit");
    const original = "#!/bin/sh\necho existing\n";
    fs.mkdirSync(hooks);
    fs.writeFileSync(hook, original);
    git(repo, ["config", "core.hooksPath", ".githooks"]);

    ab(repo, ["init"]);
    ab(repo, ["hooks", "install"]);
    const installed = fs.readFileSync(hook, "utf8");
    expect(installed).toContain(original.trimEnd());
    expect(installed).toContain("# agentbrain:start");
    expect(installed).toContain("agentbrain hook post-commit");
    expect(fs.statSync(hook).mode & 0o111).not.toBe(0);

    ab(repo, ["hooks", "install"]);
    expect(fs.readFileSync(hook, "utf8")).toBe(installed);
    ab(repo, ["hooks", "uninstall"]);
    expect(fs.readFileSync(hook, "utf8")).toBe(original);
  });

  it("records a checkpoint after a real commit", () => {
    const repo = tempRepo();
    const bin = path.join(repo, "bin");
    stubAgent(bin, "agentbrain", `exec node ${JSON.stringify(CLI)} hook post-commit`);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Capture commits"]);
    ab(repo, ["task", "update", "--next", "keep working"]);
    ab(repo, ["hooks", "install"]);
    fs.writeFileSync(path.join(repo, "change.txt"), "change\n");
    git(repo, ["add", "change.txt"], env);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "capture this"], env);

    const task = activeTask(repo);
    const checkpointDir = path.join(repo, ".agentbrain", "tasks", task.id, "checkpoints");
    const checkpointFiles = fs.readdirSync(checkpointDir).filter((file) => file.endsWith(".json"));
    expect(checkpointFiles).toHaveLength(1);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(checkpointDir, checkpointFiles[0]), "utf8"));
    expect(checkpoint.status).toBe("checkpoint");
    expect(checkpoint.stopReason).toMatch(/^commit /);
  });
});
