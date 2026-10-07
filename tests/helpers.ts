import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLI = path.resolve("dist/cli/main.js");

export function tempRepo(prefix = "agentbrain-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "demo\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

export function ab(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, AGENTBRAIN_AGENT: "", AGENTBRAIN_SESSION: "", ...env },
  });
  if (result.status !== 0) throw new Error(`agentbrain ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

export function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function activeTask(repo: string) {
  const { activeTaskId } = readJson(path.join(repo, ".agentbrain/project.json"));
  return readJson(path.join(repo, ".agentbrain/tasks", activeTaskId, "task.json"));
}

/** Writes an executable stub agent into `binDir`. */
export function stubAgent(binDir: string, name: string, script: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`);
  fs.chmodSync(file, 0o755);
}
