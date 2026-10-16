import type { TaskState } from "./state.js";
import { getProject, saveProject } from "./store.js";

/**
 * Single-focus reviewers (Anthropic runs agents that each obsess over one
 * thing): an agent that reviews every result for one concern only, like
 * security or test quality, alongside whoever decides (lead, council, or
 * nobody). Narrow paths make it review only results that touch them.
 *
 * It doesn't decide whether the work is good overall. It can only send a
 * result back over its own concern, and approval waits for it, up to
 * FOCUS_WAIT_MINUTES; after that a result lands without it, so one silent
 * focus reviewer can't stall the project.
 */

export interface FocusReviewer {
  agent: string;
  /** What it reviews for, in the developer's words ("security", "test quality"). */
  area: string;
  /** Path prefixes; when set, only results that touch them are reviewed. */
  paths?: string[];
}

export const FOCUS_WAIT_MINUTES = 30;

export function focusReviewers(root: string): FocusReviewer[] {
  const focus = getProject(root).focus ?? {};
  return Object.entries(focus).map(([agent, f]) => ({ agent, area: f.area, ...(f.paths?.length ? { paths: f.paths } : {}) }));
}

export function isFocusReviewer(root: string, agent: string): boolean {
  return Boolean(getProject(root).focus?.[agent]);
}

export function setFocus(root: string, agent: string, area: string | null, paths: string[] = []): FocusReviewer[] {
  if (!/^[a-z0-9._-]+$/.test(agent)) throw new Error(`Invalid agent id "${agent}".`);
  const project = getProject(root);
  const focus = { ...(project.focus ?? {}) };
  if (area?.trim()) focus[agent] = { area: area.trim(), ...(paths.length ? { paths } : {}) };
  else delete focus[agent];
  if (Object.keys(focus).length) project.focus = focus;
  else delete project.focus;
  saveProject(root, project);
  return focusReviewers(root);
}

const touches = (files: string[], prefix: string) =>
  files.some((f) => (prefix.endsWith("/") ? f.startsWith(prefix) : f === prefix || f.startsWith(`${prefix}/`)));

/** Focus reviewers this result needs: never its own worker; with paths, only when it touches them. */
export function focusFor(root: string, task: TaskState): FocusReviewer[] {
  const worker = task.review?.worker ?? task.agent?.id;
  const files = task.review?.change?.paths;
  return focusReviewers(root).filter((f) => f.agent !== worker &&
    // Paths need the changed files; until AgentBrain has looked, a narrowed reviewer counts as needed.
    (!f.paths || !files || f.paths.some((p) => touches(files, p))));
}

export interface FocusStatus {
  /** Focus reviewers still to vote (within the wait). */
  waiting: FocusReviewer[];
  /** Focus reviewers that asked for changes. */
  changes: FocusReviewer[];
  /** Focus reviewers that didn't vote in time and no longer hold the result up. */
  skipped: FocusReviewer[];
}

export function focusStatus(root: string, task: TaskState, now = new Date()): FocusStatus {
  const status: FocusStatus = { waiting: [], changes: [], skipped: [] };
  const review = task.review;
  if (!review) return status;
  const since = Date.parse(review.verifiedAt ?? review.requestedAt);
  const late = now.getTime() - since > FOCUS_WAIT_MINUTES * 60_000;
  for (const f of focusFor(root, task)) {
    const vote = (review.votes ?? []).find((v) => v.agent === f.agent);
    if (vote?.verdict === "changes") status.changes.push(f);
    else if (!vote) (late ? status.skipped : status.waiting).push(f);
  }
  return status;
}

/** The instructions a focus reviewer works from. */
export function focusBrief(f: FocusReviewer): string {
  return `You are this project's ${f.area} reviewer. Review this result for ${f.area} only: other reviewers ` +
    "judge everything else, so ignore style, scope and anything outside your concern. Approve unless you find a " +
    `concrete ${f.area} problem in this change; then ask for changes, naming the file, the problem and the fix.`;
}
