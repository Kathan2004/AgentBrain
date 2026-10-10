import { execFileSync } from "node:child_process";
import { gitBinary } from "./platform.js";

export interface GitState {
  /** null when the repository has no commits yet. */
  head: string | null;
  /** null on a detached HEAD. */
  branch: string | null;
  dirty: boolean;
  changedFiles: string[];
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync(gitBinary(), args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Parses `git status --porcelain -z`. Entries are NUL-separated and each
 * starts with a two-character XY code; renames/copies are followed by an
 * extra entry holding the original path.
 */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split("\0");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return files;
}

/**
 * Commits reachable from HEAD but not from `since` (newest first), as
 * "<short sha> <subject>". Empty when `since` is unknown or not a commit.
 */
export function commitsSince(cwd: string, since: string | null | undefined, max = 15): string[] {
  if (!since) return [];
  const out = git(cwd, ["log", "--no-merges", `--max-count=${max}`, "--format=%h %s", `${since}..HEAD`]);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function getGitState(cwd: string): GitState {
  // Two processes, not four: status with -b also names the branch (and fails outside a repository).
  const status = git(cwd, ["status", "--porcelain", "-b", "-z", "--untracked-files=all"]);
  if (status === null) throw new Error("AgentBrain requires a Git repository.");
  const [header, ...entries] = status.split("\0");
  const porcelain = header.startsWith("## ") ? entries.join("\0") : status;
  const named = header.startsWith("## ") ? header.slice(3).replace(/^No commits yet on /, "").split("...")[0] : "";
  const branch = named && !named.startsWith("HEAD (") ? named : null;
  const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;

  // AgentBrain's own state should not make the working tree look dirty.
  const changedFiles = parsePorcelainZ(porcelain).filter(
    (file) => file !== ".agentbrain" && !file.startsWith(".agentbrain/"),
  );

  return {
    head,
    branch,
    dirty: changedFiles.length > 0,
    changedFiles,
  };
}
