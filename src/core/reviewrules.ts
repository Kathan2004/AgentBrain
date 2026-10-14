import { execFileSync } from "node:child_process";
import { gitBinary } from "./platform.js";
import type { TaskState } from "./state.js";
import { getProject, saveProject } from "./store.js";
import { taskWorkdir } from "./worktree.js";

/**
 * Not every result needs the same review (the idea behind Anthropic's
 * Antique): a change that only touches docs or comments, with the checks
 * passing and nothing flagged, can land without waiting for a reviewer, and
 * protected paths (CI, release config, whatever the developer names) wait
 * for the developer no matter how reviewers vote.
 */

export type ChangeKind = "docs" | "comments" | "tests" | "code";
export const CHANGE_KINDS: ChangeKind[] = ["docs", "comments", "tests", "code"];

export interface ReviewRules {
  /** Kinds of change that land without a reviewer when checks pass and nothing is flagged. */
  autoApprove: ChangeKind[];
  /** Path prefixes (or globs with *) only the developer can approve changes to. */
  protect: string[];
}

export const DEFAULT_RULES: ReviewRules = { autoApprove: ["docs", "comments"], protect: [".github/workflows/"] };

export interface ChangeSummary {
  kind: ChangeKind;
  files: number;
  /** Changed files under protected paths. */
  protected?: string[];
}

const DOCS = /(^|\/)(docs?|documentation)\/|\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG|README)[^/]*$/i;
const TESTS = /(^|\/)(tests?|__tests__|specs?|fixtures)\/|[._-](test|spec)\.[a-z0-9]+$/i;
/** A line that is only a comment (or blank) in the common languages. */
const COMMENT = /^\s*($|\/\/|\/\*|\*|#(?!!)|<!--|-->|--\s|;)/;

export function reviewRules(root: string): ReviewRules {
  const r = getProject(root).review;
  return { autoApprove: r?.autoApprove ?? DEFAULT_RULES.autoApprove, protect: r?.protect ?? DEFAULT_RULES.protect };
}

export function setReviewRules(root: string, change: Partial<ReviewRules>): ReviewRules {
  const project = getProject(root);
  const current = reviewRules(root);
  for (const kind of change.autoApprove ?? []) if (!CHANGE_KINDS.includes(kind)) throw new Error(`Unknown kind "${kind}": use ${CHANGE_KINDS.join(", ")}.`);
  project.review = { ...current, ...change };
  saveProject(root, project);
  return reviewRules(root);
}

function matches(file: string, pattern: string): boolean {
  if (!pattern.includes("*")) return pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern || file.startsWith(`${pattern}/`);
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${re}$`).test(file);
}

export function protectedFiles(root: string, files: string[]): string[] {
  const { protect } = reviewRules(root);
  return files.filter((f) => protect.some((p) => matches(f, p)));
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 200_000_000 });
  } catch {
    return "";
  }
}

/** Does the file's change since `base` only add, remove or edit comment lines? */
function commentsOnly(workdir: string, base: string, file: string): boolean {
  const diff = git(workdir, ["diff", "-U0", base, "--", file]);
  if (!diff) return false;
  const lines = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map((l) => l.slice(1));
  return lines.length > 0 && lines.every((l) => COMMENT.test(l));
}

/** What kind of change a list of files (and how they changed) is. */
export function kindOf(files: { path: string; added: boolean }[], isCommentsOnly: (file: string) => boolean): ChangeKind {
  if (!files.length) return "code";
  if (files.every((f) => DOCS.test(f.path))) return "docs";
  if (files.every((f) => DOCS.test(f.path) || TESTS.test(f.path))) return "tests";
  if (files.every((f) => DOCS.test(f.path) || (!f.added && isCommentsOnly(f.path)))) return "comments";
  return "code";
}

/** Classifies a task's result: everything in its folder that differs from where it started, committed or not. */
export function describeChange(root: string, task: TaskState): ChangeSummary | undefined {
  const base = task.worktree?.base;
  if (!base) return undefined;
  const workdir = taskWorkdir(root, task);
  const tracked = git(workdir, ["diff", "--name-status", "--no-renames", base]).split("\n").filter(Boolean).map((line) => {
    const [status, ...rest] = line.split("\t");
    return { path: rest.join("\t"), added: status === "A" };
  });
  const untracked = git(workdir, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).map((p) => ({ path: p, added: true }));
  const files = [...tracked, ...untracked];
  if (!files.length) return undefined;
  const kind = kindOf(files, (file) => commentsOnly(workdir, base, file));
  const guarded = protectedFiles(root, files.map((f) => f.path));
  return { kind, files: files.length, ...(guarded.length ? { protected: guarded } : {}) };
}

/** Why the rules let this result land without a reviewer, or null. */
export function autoApproval(root: string, task: TaskState): string | null {
  const review = task.review;
  const change = review?.change;
  if (!review || !change || change.protected?.length) return null;
  if (!review.verifiedAt) return null;
  if ((review.checks ?? []).some((c) => !c.ok)) return null;
  if ((review.flags ?? []).some((f) => f.agent === review.worker)) return null;
  if ((review.votes ?? []).some((v) => v.verdict === "changes")) return null;
  if (!reviewRules(root).autoApprove.includes(change.kind)) return null;
  // Only committed work lands; anything still uncommitted waits for a reviewer.
  if (task.worktree && git(taskWorkdir(root, task), ["status", "--porcelain"]).trim()) return null;
  return `${change.kind === "comments" ? "comment" : change.kind === "docs" ? "docs" : change.kind}-only change`;
}
