import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { gitBinary } from "../core/platform.js";
import { listTasks } from "../core/store.js";

/**
 * The project's Git history as a graph, the way VS Code's Source Control graph
 * shows it: every branch (local and the remote's), which commits are only
 * local, what the working tree has uncommitted, and which agent task owns each
 * worktree. The remote is whatever `origin` is, usually GitHub; its branches
 * come from the last fetch.
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
  author: string;
  at: string;
  subject: string;
  refs: string[];
}

/** One row of the drawing: the commit's lane and the lines through its row. */
export interface GraphRow {
  lane: number;
  /** Lanes that pass straight through this row. */
  through: number[];
  /** Lanes that come down into this commit (it is their parent). */
  into: number[];
  /** Lanes this commit continues into below: its first parent's, then merge parents'. */
  out: number[];
}

/** Lays commits (newest first, topological order) out in lanes. Pure, so it is tested directly. */
export function layoutGraph(commits: GraphCommit[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 1;
  const free = (skip: number) => {
    const i = lanes.findIndex((l, j) => l === null && j !== skip);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) lane = free(-1);
    const into: number[] = [];
    const through: number[] = [];
    lanes.forEach((l, j) => {
      if (l === null) return;
      if (l === commit.hash) into.push(j);
      else through.push(j);
    });
    for (const j of into) lanes[j] = null;
    const out: number[] = [];
    commit.parents.forEach((parent, i) => {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) {
        out.push(existing);
        return;
      }
      const target = i === 0 ? lane : free(lane);
      lanes[target] = parent;
      out.push(target);
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    width = Math.max(width, lane + 1, ...through.map((j) => j + 1), ...out.map((j) => j + 1), ...into.map((j) => j + 1));
    rows.push({ lane, through, into, out });
  }
  return { rows, width };
}

export interface GitGraph {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** https URL of the remote's web page, when it has one (GitHub, GitLab…); never carries credentials. */
  web: string | null;
  remoteName: string | null;
  changes: { status: string; path: string }[];
  worktrees: { path: string; branch: string | null; head: string; task?: { id: string; title: string; status: string } }[];
  /** local: on no remote branch yet (not pushed). */
  commits: (GraphCommit & { local: boolean; row: GraphRow })[];
  width: number;
  head: string | null;
}

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(gitBinary(), args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
    return stdout;
  } catch {
    return "";
  }
}

/** git@github.com:o/r.git or https://user:tok@github.com/o/r.git → https://github.com/o/r */
export function webUrl(remote: string): string | null {
  const url = remote.trim();
  if (!url) return null;
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return `https://${parsed.host}${parsed.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

const SEP = "\x1f";

export async function gitGraph(root: string, limit = 250): Promise<GitGraph> {
  const [log, status, worktreeList, remote, unpushed, head] = await Promise.all([
    git(root, ["log", "--all", "--topo-order", "-n", String(limit), `--format=%H${SEP}%P${SEP}%an${SEP}%aI${SEP}%s${SEP}%D`]),
    git(root, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]),
    git(root, ["worktree", "list", "--porcelain"]),
    git(root, ["remote", "get-url", "origin"]),
    git(root, ["rev-list", "--all", "--not", "--remotes", "-n", "5000"]),
    git(root, ["rev-parse", "HEAD"]),
  ]);

  const commits: GraphCommit[] = log.split("\n").filter(Boolean).map((line) => {
    const [hash, parents, author, at, subject, refs] = line.split(SEP);
    return {
      hash,
      parents: parents ? parents.split(" ") : [],
      author,
      at,
      subject,
      refs: refs ? refs.split(", ").map((r) => r.trim()).filter((r) => r && r !== "origin/HEAD") : [],
    };
  });
  const { rows, width } = layoutGraph(commits);
  const localOnly = new Set(unpushed.split("\n").filter(Boolean));

  const lines = status.split("\n").filter(Boolean);
  const head0 = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  const branchMatch = /^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.+)\])?/.exec(head0);
  const counts = branchMatch?.[3] ?? "";
  const changes = lines.map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));

  const tasks = listTasks(root);
  const worktrees: GitGraph["worktrees"] = [];
  for (const block of worktreeList.split("\n\n")) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (!wt) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    const task = tasks.find((t) => t.worktree && path.resolve(t.worktree.path) === path.resolve(wt));
    worktrees.push({
      path: wt,
      branch,
      head: /^HEAD (\w+)$/m.exec(block)?.[1] ?? "",
      task: task ? { id: task.id, title: task.objective.split("\n")[0].slice(0, 120), status: task.status } : undefined,
    });
  }

  return {
    branch: branchMatch?.[1] && branchMatch[1] !== "HEAD" ? branchMatch[1] : null,
    upstream: branchMatch?.[2] ?? null,
    ahead: Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(counts)?.[1] ?? 0),
    web: webUrl(remote),
    remoteName: remote.trim() ? "origin" : null,
    changes,
    worktrees,
    commits: commits.map((c, i) => ({ ...c, local: Boolean(remote.trim()) && localOnly.has(c.hash), row: rows[i] })),
    width,
    head: head.trim() || null,
  };
}

/** Brings the remote's branches up to date (read-only for the remote). */
export async function gitFetch(root: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(gitBinary(), ["fetch", "--prune", "origin"], { cwd: root, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as { stderr?: string }).stderr || (error as Error).message).trim().split("\n").at(-1) };
  }
}

/** Today's commits on every branch, one line each, for the chat brief. */
export async function gitToday(root: string, limit = 40): Promise<string> {
  return git(root, ["log", "--all", "--since=midnight", "-n", String(limit), "--format=%h %ad %s (%an)", "--date=format:%H:%M"]);
}
