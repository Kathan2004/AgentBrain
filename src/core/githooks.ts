import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeCheckpoint } from "./actions.js";
import { findRoot } from "./paths.js";
import { getProject, getTask } from "./store.js";

const START = "# agentbrain:start";
const END = "# agentbrain:end";
const BODY = "command -v agentbrain >/dev/null 2>&1 && agentbrain hook post-commit >/dev/null 2>&1 || true";
const BLOCK = `${START}\n${BODY}\n${END}`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function hooksFile(cwd: string): string {
  const hooks = git(cwd, ["rev-parse", "--git-path", "hooks"]);
  return path.isAbsolute(hooks) ? hooks : path.resolve(cwd, hooks);
}

function withoutBlock(content: string): string {
  return content.replace(new RegExp(`\\n?${START}\\n[\\s\\S]*?${END}\\n?`, "g"), "");
}

export function installPostCommitHook(cwd: string): string {
  const file = path.join(hooksFile(cwd), "post-commit");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "#!/bin/sh\n";
  const content = `${withoutBlock(existing).replace(/\n+$/, "\n")}\n${BLOCK}\n`;
  fs.writeFileSync(file, content, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

export function uninstallPostCommitHook(cwd: string): string {
  const file = path.join(hooksFile(cwd), "post-commit");
  if (!fs.existsSync(file)) return file;
  const existing = fs.readFileSync(file, "utf8");
  const restored = withoutBlock(existing);
  if (restored === "#!/bin/sh\n" || restored === "#!/bin/sh") fs.rmSync(file);
  else fs.writeFileSync(file, restored, "utf8");
  return file;
}

export function postCommit(cwd: string): void {
  try {
    const root = findRoot(cwd);
    if (!root) return;
    const project = getProject(root);
    if (!project.activeTaskId) return;
    const task = getTask(root, project.activeTaskId);
    if (task.status !== "running") return;
    const sha = git(root, ["rev-parse", "--short", "HEAD"]);
    const subject = git(root, ["log", "-1", "--pretty=%s"]);
    writeCheckpoint(root, task.id, { reason: `commit ${sha}: ${subject}`, status: "checkpoint" });
  } catch {
    // A commit must never depend on AgentBrain being available or healthy.
  }
}
