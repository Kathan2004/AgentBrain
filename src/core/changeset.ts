import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brainDir } from "./paths.js";
import { gitBinary } from "./platform.js";

/**
 * Results land as changesets, not branch merges (the idea behind Anthropic's
 * Scion): a result is the list of files it changed since the point it started
 * from, each with a content-addressed blob in Git's object store. Landing
 * merges each of those files with main's version against that starting point,
 * builds the new commit in a throwaway index, and moves the branch with a
 * compare-and-swap. So a result never conflicts over history it doesn't
 * touch (a squash or rebase of main is fine), and junk an agent committed
 * by accident, like a node_modules link to another checkout, is left out.
 */

export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D";
  /** The file's mode and blob in the result; blob is null when the result deletes it. */
  mode: string;
  blob: string | null;
  /** The file's blob at the starting point; null when the result adds it. */
  baseBlob: string | null;
}

export interface Changes {
  files: ChangedFile[];
  /** Paths left out, with why. */
  skipped: { path: string; why: string }[];
}

export interface LandResult extends Changes {
  /** The new commit on main; absent when there was nothing to land or it conflicted. */
  commit?: string;
  conflicts: string[];
}

/** One line of the changeset log: what landed, from which task, by whom. */
export interface ChangesetRecord {
  id: string;
  task: string;
  agent?: string;
  base: string;
  tip: string;
  commit: string;
  at: string;
  files: { path: string; status: ChangedFile["status"] }[];
  kind?: string;
}

const ZERO = "0".repeat(40);
const MARKERS = /^<{7} [^\n]*\n[\s\S]*?^>{7} /m;

function git(cwd: string, args: string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(gitBinary(), args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 200_000_000,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.env ? { env: options.env } : {}),
  }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function blob(cwd: string, sha: string): Buffer {
  return execFileSync(gitBinary(), ["cat-file", "blob", sha], { cwd, maxBuffer: 200_000_000 });
}

/** The file's mode and blob at a commit, or null when it isn't there. */
function entryAt(cwd: string, commit: string, file: string): { mode: string; sha: string } | null {
  const line = tryGit(cwd, ["ls-tree", commit, "--", file]);
  const m = line ? /^(\d+) blob ([0-9a-f]+)\t/.exec(line) : null;
  return m ? { mode: m[1], sha: m[2] } : null;
}

export function isAncestor(cwd: string, a: string, b: string): boolean {
  return spawnSync(gitBinary(), ["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;
}

/**
 * Where the result's changes start. The point recorded when the task began,
 * unless the branch has since taken in newer main (an agent merging main to
 * resolve conflicts): then that newer shared point, so main's own changes
 * don't count as the result's.
 */
export function startingPoint(cwd: string, recorded: string | undefined, tip: string, head: string): string {
  const shared = tryGit(cwd, ["merge-base", head, tip]);
  if (shared && (!recorded || isAncestor(cwd, recorded, shared))) return shared;
  if (recorded) return recorded;
  throw new Error("Can't tell where this result started: it shares no history with main.");
}

/** Files the result changed since `base`. */
export function changedFiles(cwd: string, base: string, tip: string): Changes {
  const raw = execFileSync(gitBinary(), ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, tip], { cwd, encoding: "utf8", maxBuffer: 200_000_000 });
  const parts = raw.split("\0");
  const files: ChangedFile[] = [];
  const skipped: Changes["skipped"] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])/.exec(parts[i]);
    if (!m) continue;
    const file = parts[i + 1];
    const [, oldMode, newMode, oldSha, newSha, code] = m;
    const status = code === "A" ? "A" : code === "D" ? "D" : "M";
    if (newMode === "120000") {
      // A link out of the repository (to another checkout's node_modules, say) only works on one machine.
      const target = blob(cwd, newSha).toString("utf8");
      if (path.isAbsolute(target) || path.normalize(path.join(path.dirname(file), target)).startsWith("..")) {
        skipped.push({ path: file, why: `a link to ${target}, outside the repository` });
        continue;
      }
    }
    files.push({
      path: file,
      status,
      mode: status === "D" ? oldMode : newMode,
      blob: status === "D" ? null : newSha,
      baseBlob: status === "A" ? null : oldSha,
    });
  }
  return { files, skipped };
}

interface Entry {
  path: string;
  mode: string;
  /** null removes the file. */
  sha: string | null;
}

/** Main's version merged with the result's, against where the result started. */
function mergeFile(cwd: string, ours: string, base: string, theirs: string, label: string): { text: Buffer; clean: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-merge-"));
  try {
    const [o, b, t] = ["main", "base", "result"].map((name, i) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, blob(cwd, [ours, base, theirs][i]));
      return file;
    });
    const result = spawnSync(gitBinary(), ["merge-file", "-p", "-L", "main", "-L", "start", "-L", label, o, b, t], { cwd, maxBuffer: 200_000_000 });
    if (result.status === null || result.status < 0) throw new Error(`git merge-file failed: ${result.stderr}`);
    return { text: result.stdout, clean: result.status === 0 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeBlob(cwd: string, content: Buffer): string {
  return git(cwd, ["hash-object", "-w", "--stdin"], { input: content });
}

/**
 * The result's files combined with main's. `markers` also returns, for each
 * conflicting file, main's version merged with conflict markers (or the
 * result's own when one side deleted it), to hand back to the agent.
 */
function combine(cwd: string, head: string, files: ChangedFile[], label: string, markers = false): { entries: Entry[]; conflicts: string[] } {
  const entries: Entry[] = [];
  const conflicts: string[] = [];
  for (const f of files) {
    const main = entryAt(cwd, head, f.path);
    if ((main?.sha ?? null) === f.blob) continue; // already on main
    const take = (sha: string | null): void => {
      entries.push({ path: f.path, mode: f.mode, sha });
    };
    if ((main?.sha ?? null) === f.baseBlob) {
      // Main hasn't touched it since the result started: the result's version stands,
      // unless it still holds conflict markers from an earlier hand-back.
      if (f.blob && MARKERS.test(blob(cwd, f.blob).toString("utf8"))) {
        conflicts.push(f.path);
        if (markers) take(f.blob);
      } else take(f.blob);
      continue;
    }
    if (main && f.blob && f.baseBlob) {
      const merged = mergeFile(cwd, main.sha, f.baseBlob, f.blob, label);
      if (merged.clean) {
        entries.push({ path: f.path, mode: f.mode, sha: writeBlob(cwd, merged.text) });
        continue;
      }
      conflicts.push(f.path);
      if (markers) entries.push({ path: f.path, mode: f.mode, sha: writeBlob(cwd, merged.text) });
      continue;
    }
    // Added on both sides, or deleted on one and changed on the other.
    conflicts.push(f.path);
    if (markers && f.blob) take(f.blob);
  }
  return { entries, conflicts };
}

/** A commit with `parents`, whose tree is `from`'s with `entries` applied. Built in a throwaway index. */
function commitWith(cwd: string, from: string, entries: Entry[], message: string, parents: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-idx-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    git(cwd, ["read-tree", from], { env });
    const info = entries.map((e) => (e.sha ? `${e.mode} ${e.sha}\t${e.path}` : `0 ${ZERO}\t${e.path}`)).join("\n");
    if (info) git(cwd, ["update-index", "--index-info"], { env, input: `${info}\n` });
    const tree = git(cwd, ["write-tree"], { env });
    return git(cwd, ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], { input: message });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Moves `ref` from `from` to `to`, updating the checkout at `cwd` (only the
 * files that differ; uncommitted work elsewhere is kept). Git refuses when
 * uncommitted changes or untracked files are in the way, and nothing moves.
 * The ref moves only if it is still at `from` (compare-and-swap).
 */
function advance(cwd: string, ref: string, from: string, to: string): void {
  try {
    git(cwd, ["read-tree", "-m", "-u", from, to]);
  } catch (error) {
    const why = String((error as { stderr?: string }).stderr ?? error).split("\n").find((l) => l.trim()) ?? "files are in the way";
    throw new Error(`Can't merge yet: ${why.replace(/^error: /, "")}`);
  }
  try {
    git(cwd, ["update-ref", ref, to, from]);
  } catch {
    git(cwd, ["read-tree", "-m", "-u", to, from]);
    throw new Error("moved");
  }
}

/**
 * Lands the result `tip` (which started at `base`) on the branch checked out
 * at `cwd`. Nothing changes on conflict. Retries when main moves meanwhile.
 */
export function landChanges(cwd: string, options: { base: string; tip: string; message: string; label: string }): LandResult {
  for (let attempt = 0; ; attempt++) {
    const head = git(cwd, ["rev-parse", "HEAD"]);
    const changes = changedFiles(cwd, options.base, options.tip);
    const { entries, conflicts } = combine(cwd, head, changes.files, options.label);
    if (conflicts.length || !entries.length) return { ...changes, conflicts };
    const commit = commitWith(cwd, head, entries, options.message, [head]);
    try {
      advance(cwd, "HEAD", head, commit);
      return { ...changes, commit, conflicts: [] };
    } catch (error) {
      if (!(error instanceof Error && error.message === "moved") || attempt >= 3) throw error;
    }
  }
}

/**
 * Brings a result's branch up to date with main: a merge commit whose files
 * are main's plus the result's, with conflict markers only in the files that
 * really conflict. Returns the commit main was at (the new starting point).
 */
export function bringUpToDate(root: string, worktree: { path: string; branch: string }, base: string, label: string): { head: string; conflicts: string[] } {
  const head = git(root, ["rev-parse", "HEAD"]);
  const tip = git(root, ["rev-parse", worktree.branch]);
  const { files } = changedFiles(root, base, tip);
  const { entries, conflicts } = combine(root, head, files, label, true);
  const message = `Bring ${worktree.branch} up to date with main${conflicts.length ? `\n\nConflicts to resolve: ${conflicts.join(", ")}` : ""}`;
  const commit = commitWith(root, head, entries, message, [tip, head]);
  advance(worktree.path, "HEAD", tip, commit);
  return { head, conflicts };
}

export function changesetLog(root: string): string {
  return path.join(brainDir(root), "changesets.jsonl");
}

export function recordChangeset(root: string, record: ChangesetRecord): void {
  fs.mkdirSync(path.dirname(changesetLog(root)), { recursive: true });
  fs.appendFileSync(changesetLog(root), `${JSON.stringify(record)}\n`);
}

export function readChangesets(root: string): ChangesetRecord[] {
  const file = changesetLog(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as ChangesetRecord];
    } catch {
      return [];
    }
  });
}
