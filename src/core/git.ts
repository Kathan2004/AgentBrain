import { execFileSync } from "node:child_process";

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
    return execFileSync("git", args, {
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

export function getGitState(cwd: string): GitState {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
    throw new Error("AgentBrain requires a Git repository.");
  }

  const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
  const branch = git(cwd, ["branch", "--show-current"])?.trim() || null;
  const porcelain = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]) ?? "";

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
