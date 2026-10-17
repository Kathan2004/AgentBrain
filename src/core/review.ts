import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readActivity, recordActivity } from "./activity.js";
import { commitsSince } from "./git.js";
import { brainDir } from "./paths.js";
import { compilePatterns, redact } from "./redact.js";
import type { ReviewCheck, ReviewFlag, ReviewVote, TaskState } from "./state.js";
import { getProject, getTask, listTasks, readJson, saveProject, saveTask, writeJson } from "./store.js";
import { focusBrief, focusFor, focusReviewers, focusStatus, isFocusReviewer } from "./focus.js";
import { autoApproval, describeChange } from "./reviewrules.js";
import { mergeWorktree, syncWorktree, taskWorkdir } from "./worktree.js";
import { gitBinary } from "./platform.js";

/**
 * Who decides whether finished work counts.
 *
 * - No reviewers: agents finish their own tasks.
 * - A lead: one agent reviews everyone else's work.
 * - A council: several agents vote independently. Votes are sealed until each
 *   reviewer has cast its own, weighted by reputation (earned by agreeing with
 *   outcomes and by making claims that check out), and a result passes only
 *   with a quorum of that weight, so a minority of broken, compromised or
 *   hallucinating reviewers cannot decide on their own.
 *
 * Either way AgentBrain runs the project's checks itself and compares every
 * agent's claims with the evidence, flagging what does not match.
 */

const ALIASES: Record<string, string> = { claude: "claude-code", "claude code": "claude-code", copilot: "vscode" };
const DEFAULT_QUORUM = 2 / 3;

export function normalizeAgentId(id: string): string {
  const key = id.trim().toLowerCase();
  const normalized = ALIASES[key] ?? key;
  if (!/^[a-z0-9._-]+$/.test(normalized)) throw new Error(`Invalid agent id "${id}".`);
  return normalized;
}

export interface ReviewPolicy {
  mode: "none" | "lead" | "council";
  reviewers: string[];
  quorum: number;
  checks: string[];
}

/** The to-do a task gets when its approved branch conflicts with main. */
export const CONFLICT_PREFIX = "Resolve the conflict markers AgentBrain left (main changed the same lines) in";

export function reviewPriority(task: Pick<TaskState, "review">): number {
  const priorities: Record<ReviewFlag["kind"], number> = {
    hallucination: 3,
    "false-claim": 2,
    "no-change": 1,
    dissent: 0,
  };
  return Math.max(...(task.review?.flags ?? []).map((flag) => priorities[flag.kind] ?? 0), 0);
}

export function reviewPolicy(root: string): ReviewPolicy {
  const project = getProject(root);
  const checks = project.checks ?? [];
  if (project.council?.members.length) {
    return { mode: "council", reviewers: project.council.members, quorum: project.council.quorum ?? DEFAULT_QUORUM, checks };
  }
  if (project.lead) return { mode: "lead", reviewers: [project.lead], quorum: 1, checks };
  return { mode: "none", reviewers: [], quorum: 1, checks };
}

/** How many corrupted reviewers a council survives: n ≥ 3f + 1 at a two-thirds quorum. */
export function faultTolerance(members: number, quorum: number): number {
  // With equal reputation the honest reviewers alone must reach the quorum (n − f ≥ q·n),
  // and the corrupted ones alone can neither approve (f < q·n) nor force changes (f ≤ (1 − q)·n).
  return Math.max(0, Math.floor(members * (1 - quorum) + 1e-9));
}

export function getLead(root: string): string | undefined {
  return getProject(root).lead;
}

export function setLead(root: string, agentId: string | null): string | undefined {
  const project = getProject(root);
  if (agentId) project.lead = normalizeAgentId(agentId);
  else delete project.lead;
  delete project.council;
  saveProject(root, project);
  recordActivity(root, { agent: "developer", kind: "review", text: project.lead ? `Lead agent is now ${project.lead}` : "No reviewers: agents finish their own work" });
  return project.lead;
}

export function setCouncil(root: string, members: string[] | null, quorum?: number): ReviewPolicy {
  const project = getProject(root);
  if (members?.length) {
    const ids = [...new Set(members.map(normalizeAgentId))];
    if (quorum !== undefined && !(quorum > 0.5 && quorum <= 1)) throw new Error("Quorum must be above 0.5 and at most 1 (e.g. 0.67).");
    project.council = { members: ids, ...(quorum !== undefined ? { quorum } : {}) };
    delete project.lead;
  } else delete project.council;
  saveProject(root, project);
  const policy = reviewPolicy(root);
  recordActivity(root, {
    agent: "developer",
    kind: "review",
    text: policy.mode === "council"
      ? `Council: ${policy.reviewers.join(", ")}; quorum ${Math.round(policy.quorum * 100)}%, survives ${faultTolerance(policy.reviewers.length, policy.quorum)} corrupted reviewer(s)`
      : "Council dissolved",
  });
  return policy;
}

export function setChecks(root: string, checks: string[]): string[] {
  const project = getProject(root);
  if (checks.length) project.checks = checks;
  else delete project.checks;
  saveProject(root, project);
  return checks;
}

/** Reviews results: the lead, a council member, or a focus reviewer. */
export function isReviewer(root: string, agentId: string): boolean {
  return reviewPolicy(root).reviewers.includes(agentId) || isFocusReviewer(root, agentId);
}

/* ---------- reputation (the stake) ---------- */

export interface Reputation {
  score: number;
  agreed: number;
  dissented: number;
  flagged: number;
}

const START = 1;
const clamp = (n: number) => Math.min(3, Math.max(0.2, Math.round(n * 100) / 100));

function reputationFile(root: string): string {
  return path.join(brainDir(root), "reputation.json");
}

export function readReputation(root: string): Record<string, Reputation> {
  const file = reputationFile(root);
  return fs.existsSync(file) ? readJson<Record<string, Reputation>>(file) : {};
}

export function weightOf(root: string, agentId: string): number {
  return readReputation(root)[agentId]?.score ?? START;
}

function adjust(root: string, agentId: string, change: Partial<Reputation> & { delta: number }): void {
  const all = readReputation(root);
  const r = all[agentId] ?? { score: START, agreed: 0, dissented: 0, flagged: 0 };
  r.score = clamp(r.score + change.delta);
  r.agreed += change.agreed ?? 0;
  r.dissented += change.dissented ?? 0;
  r.flagged += change.flagged ?? 0;
  all[agentId] = r;
  writeJson(reputationFile(root), all);
}

/* ---------- submission: the gate, checks, claim verification ---------- */

/**
 * Called by updateTask after a patch: when reviewers are set, finished work
 * waits for them. In lead mode the lead finishes its own tasks; in a council
 * every agent's work is reviewed by the others. Mutates `task`.
 */
export function gateFinish(root: string, task: TaskState, previous: TaskState["status"], agentId: string | undefined): boolean {
  const policy = reviewPolicy(root);
  if (!agentId) return false;
  // With no lead or council, focus reviewers still look at other agents' work.
  if (policy.mode === "none" && !focusReviewers(root).some((f) => f.agent !== agentId)) return false;
  if (policy.mode === "lead" && agentId === policy.reviewers[0]) return false;
  if (task.status !== "done" && task.status !== "review") return false;
  task.status = "review";
  if (previous === "review" && task.review) return false;
  task.review = { worker: agentId, requestedAt: new Date().toISOString(), votes: [], checks: [], flags: [] };
  return true;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Paths an agent mentions (src/x.ts, README.md, ...). */
function mentionedFiles(text: string): string[] {
  const found = text.match(/(?<![\w/.-])(?:\.?[\w-]+\/)*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|css|html|yml|yaml|toml|sh)\b/g) ?? [];
  return [...new Set(found)];
}

/**
 * Mentioned paths that aren't there. Only paths with a folder count: a bare
 * name ("Brain.md") is as likely a note, a generated file or a plan as a claim.
 */
function missingFiles(workdir: string, text: string, root?: string): string[] {
  // "src/a.ts/b.ts" is shorthand for two files in one folder, not one path.
  const mentioned = mentionedFiles(text).flatMap((file) => {
    const m = /^(.*\/)?([^/]+\.[a-z]+)\/([^/]+\.[a-z]+)$/.exec(file);
    return m ? [`${m[1] ?? ""}${m[2]}`, `${m[1] ?? ""}${m[3]}`] : [file];
  });
  return mentioned.filter((file) => file.includes("/") && !file.startsWith(".agentbrain/") &&
    // Files Git ignores (local config, state) exist in the main checkout but not in a task's worktree.
    !fs.existsSync(path.join(workdir, file)) && !(root && fs.existsSync(path.join(root, file))));
}

function changedSinceBase(root: string, task: TaskState): boolean {
  const workdir = taskWorkdir(root, task);
  if (git(workdir, ["status", "--porcelain"])) return true;
  const base = task.worktree?.base;
  return base ? git(workdir, ["rev-list", "--count", `${base}..HEAD`]) !== "0" : true;
}

const CLAIMS_TESTS = /\b(tests?|specs?|ci|build|type-?check)\b[^.]*\b(pass|passes|passing|passed|green|succeed|succeeds|ok)\b/i;

/** Compares what the worker says it did with what is actually there. */
export function verifyClaims(root: string, task: TaskState, checks: ReviewCheck[]): ReviewFlag[] {
  const worker = task.review?.worker ?? task.agent?.id ?? "unknown";
  const workdir = taskWorkdir(root, task);
  // Only what the worker itself said counts against it: a planner's or reviewer's notes don't.
  const own = new Set(readActivity(root, 2000).filter((e) => e.task === task.id && e.agent === worker && (e.kind === "decision" || e.kind === "progress")).map((e) => e.text.replace(/^Done: /, "")));
  const claims = [...task.completed, ...task.decisions].filter((c) => own.size === 0 || own.has(c)).join("\n");
  const flags: ReviewFlag[] = [];
  const at = new Date().toISOString();
  if (!changedSinceBase(root, task)) {
    flags.push({ agent: worker, kind: "no-change", text: "Says the work is finished, but nothing changed in its folder or branch.", at });
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length && CLAIMS_TESTS.test(claims)) {
    flags.push({ agent: worker, kind: "false-claim", text: `Claims checks pass, but AgentBrain's own run failed: ${failed.map((c) => c.command).join(", ")}.`, at });
  }
  const missing = missingFiles(workdir, claims, root);
  if (missing.length) {
    flags.push({ agent: worker, kind: "hallucination", text: `Mentions files that do not exist: ${missing.join(", ")}.`, at });
  }
  return flags;
}

function runCheck(workdir: string, command: string): ReviewCheck {
  const started = Date.now();
  const result = spawnSync(command, { cwd: workdir, shell: true, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 20_000_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
  return { command, ok: result.status === 0, exitCode: result.status, tail: output, ms: Date.now() - started, at: new Date().toISOString() };
}

/**
 * Runs the project's checks in the task's folder and verifies the worker's
 * claims. Slow (it runs your test suite), so submissions start it in the
 * background with `startVerification`.
 */
export function verifyTask(root: string, taskId: string): ReviewResult {
  const task = getTask(root, taskId);
  if (task.status !== "review") return { task };
  if (!task.review) {
    // Submitted by an older AgentBrain (or set by hand): open the review now.
    task.review = { worker: task.agent?.id ?? "unknown", requestedAt: new Date().toISOString(), votes: [], checks: [], flags: [] };
    saveTask(root, task);
  }
  const workdir = taskWorkdir(root, task);
  const checks = reviewPolicy(root).checks.map((command) => runCheck(workdir, command));
  const after = getTask(root, taskId);
  if (!after.review || after.review.requestedAt !== task.review.requestedAt) return { task: after };
  after.review.checks = checks;
  const change = describeChange(root, after);
  if (change) after.review.change = change;
  else delete after.review.change;
  after.review.flags = [...(after.review.flags ?? []).filter((f) => f.kind === "dissent" || f.agent !== after.review!.worker), ...verifyClaims(root, after, checks)];
  after.review.verifiedAt = new Date().toISOString();
  saveTask(root, after);
  for (const c of checks) {
    recordActivity(root, { agent: "agentbrain", task: taskId, kind: "review", text: `${c.ok ? "✓" : "✗"} ${c.command} (${Math.round(c.ms / 1000)}s)` });
  }
  for (const f of after.review.flags.filter((f) => f.agent === after.review!.worker)) {
    adjust(root, f.agent, { delta: -0.3, flagged: 1 });
    recordActivity(root, { agent: "agentbrain", task: taskId, kind: "review", text: `⚠ ${f.agent}: ${f.text}` });
  }
  return tally(root, taskId);
}

/** Starts verification in a background AgentBrain process when possible, else runs it now. */
export function startVerification(root: string, taskId: string): void {
  const cli = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  if (fs.existsSync(cli) && reviewPolicy(root).checks.length) {
    spawn(process.execPath, [cli, "review", taskId, "--verify"], { cwd: root, detached: true, stdio: "ignore" }).unref();
  } else {
    verifyTask(root, taskId);
  }
}

/* ---------- votes and the decision ---------- */

export interface Tally {
  eligible: string[];
  approve: number;
  changes: number;
  total: number;
  quorum: number;
  tolerates: number;
  outcome: "approved" | "changes" | "pending";
  /** Why approval is blocked regardless of votes. */
  blocked?: string;
  /** Focus reviewers still to vote, and those that asked for changes ("agent (area)"). */
  focus?: { waiting: string[]; changes: string[]; skipped: string[] };
}

export function computeTally(root: string, task: TaskState): Tally {
  const policy = reviewPolicy(root);
  const worker = task.review?.worker;
  // Nobody reviews their own work.
  let eligible = policy.reviewers.filter((r) => r !== worker);
  // A stand-in decides in the lead's place, unless the lead votes after all.
  const standIn = task.review?.standIn?.agent;
  if (policy.mode === "lead" && standIn && standIn !== worker && !(task.review?.votes ?? []).some((v) => eligible.includes(v.agent))) eligible = [standIn];
  const weight = (id: string) => (policy.mode === "council" ? weightOf(root, id) : 1);
  const total = eligible.reduce((sum, id) => sum + weight(id), 0);
  const votes = (task.review?.votes ?? []).filter((v) => eligible.includes(v.agent));
  const approve = votes.filter((v) => v.verdict === "approved").reduce((s, v) => s + weight(v.agent), 0);
  const changes = votes.filter((v) => v.verdict === "changes").reduce((s, v) => s + weight(v.agent), 0);
  const failed = (task.review?.checks ?? []).filter((c) => !c.ok);
  const pendingChecks = policy.checks.length > 0 && Boolean(task.review) && !task.review?.verifiedAt;
  const guarded = task.review?.change?.protected ?? [];
  let blocked = failed.length ? `checks failed: ${failed.map((c) => c.command).join(", ")}` : pendingChecks ? "checks still running"
    : guarded.length ? `protected files need the developer: ${guarded.join(", ")}` : undefined;
  const quorum = policy.mode === "council" ? policy.quorum : 1;
  let outcome: Tally["outcome"] = "pending";
  if (total > 0 && changes / total > 1 - quorum + 1e-9) outcome = "changes";
  else if (total > 0 && approve / total >= quorum - 1e-9 && !blocked) outcome = "approved";
  else if (failed.length && total > 0 && approve + changes >= total) outcome = "changes";
  // Nobody decides (no lead or council): the focus reviewers alone stand between the result and main.
  else if (policy.mode === "none" && total === 0 && !blocked && focusFor(root, task).length) outcome = "approved";
  const watch = focusStatus(root, task);
  const label = (f: { agent: string; area: string }) => `${f.agent} (${f.area})`;
  const focus = { waiting: watch.waiting.map(label), changes: watch.changes.map(label), skipped: watch.skipped.map(label) };
  if (focus.changes.length) outcome = "changes";
  else if (focus.waiting.length && outcome === "approved") {
    outcome = "pending";
    blocked ??= `waiting for the focus review of ${focus.waiting.join(", ")}`;
  }
  return { eligible, approve, changes, total, quorum, tolerates: policy.mode === "council" ? faultTolerance(eligible.length, quorum) : 0, outcome, ...(blocked ? { blocked } : {}),
    ...(focus.waiting.length || focus.changes.length || focus.skipped.length ? { focus } : {}) };
}

export function pendingReviews(root: string): TaskState[] {
  return listTasks(root)
    .filter((t) => t.status === "review")
    .sort((a, b) =>
      reviewPriority(b) - reviewPriority(a) ||
      (a.review?.requestedAt ?? a.updatedAt ?? "").localeCompare(b.review?.requestedAt ?? b.updatedAt ?? ""),
    );
}

/** Results this agent still has to vote on. */
export function awaitingVote(root: string, agentId: string): TaskState[] {
  const reviewer = reviewPolicy(root).reviewers.includes(agentId);
  return pendingReviews(root).filter((t) => !t.review?.pendingMerge &&
    (reviewer || t.review?.standIn?.agent === agentId || focusFor(root, t).some((f) => f.agent === agentId)) &&
    t.review?.worker !== agentId && !(t.review?.votes ?? []).some((v) => v.agent === agentId));
}

export interface ReviewResult {
  task: TaskState;
  /** Set once the votes decide (or the developer overrides). */
  outcome?: "approved" | "changes";
  /** Approved, but waiting for the main checkout to be clean before merging. */
  pendingMerge?: string;
  merged?: number;
  conflicts?: string[];
  tally?: Tally;
}

/**
 * Casts a reviewer's vote, then applies the decision if the votes now reach
 * one. A developer verdict decides immediately (an override, recorded as such).
 */
export function reviewTask(
  root: string,
  taskId: string,
  options: { verdict: "approved" | "changes"; reviewer: string; notes?: string },
): ReviewResult {
  const task = getTask(root, taskId);
  if (task.status !== "review") throw new Error(`${task.id} is ${task.status}, not waiting for review.`);
  task.review ??= { worker: task.agent?.id ?? "unknown", requestedAt: new Date().toISOString(), votes: [], checks: [], flags: [] };
  const notes = options.notes?.trim() ? redact(options.notes.trim(), compilePatterns(getProject(root).redactPatterns)) : undefined;
  if (options.verdict === "changes" && !notes) throw new Error("Say what needs to change (notes).");
  // Only the developer overrides. An agent decides only as a reviewer or stand-in, and never on its own work
  // (a model tier isn't its lead: claude-code.sonnet can't approve as claude-code).
  const developer = options.reviewer === "developer";
  if (!developer && options.reviewer === task.review.worker) throw new Error("You can't review your own work.");
  if (!developer && !isReviewer(root, options.reviewer) && task.review.standIn?.agent !== options.reviewer) {
    throw new Error(`${options.reviewer} isn't a reviewer of this result; ${reviewPolicy(root).reviewers.join(", ") || "the developer"} decides.`);
  }

  if (developer) return decide(root, task, options.verdict, `${options.reviewer} (override)`, notes);

  const vote: ReviewVote = { agent: options.reviewer, verdict: options.verdict, ...(notes ? { notes } : {}), at: new Date().toISOString() };
  task.review.votes = [...(task.review.votes ?? []).filter((v) => v.agent !== options.reviewer), vote];
  // A reviewer citing files that aren't there is hallucinating its review.
  const missing = notes ? missingFiles(taskWorkdir(root, task), notes) : [];
  if (missing.length) {
    task.review.flags = [...(task.review.flags ?? []), { agent: options.reviewer, kind: "hallucination", text: `Its review cites files that do not exist: ${missing.join(", ")}.`, at: vote.at }];
    adjust(root, options.reviewer, { delta: -0.3, flagged: 1 });
  }
  saveTask(root, task);
  recordActivity(root, {
    agent: options.reviewer,
    task: task.id,
    kind: "review",
    text: reviewPolicy(root).mode === "council"
      ? `Voted ${options.verdict === "approved" ? "approve" : "changes"} on ${task.review.worker}'s work (sealed until the others vote)`
      : `Reviewed ${task.review.worker}'s work: ${options.verdict === "approved" ? "approve" : "changes"}`,
  });
  return tally(root, task.id);
}

/** Applies the decision once the votes reach it. */
function tally(root: string, taskId: string): ReviewResult {
  const task = getTask(root, taskId);
  if (task.status !== "review") return { task };
  const t = computeTally(root, task);
  if (t.outcome === "pending") {
    // Low-risk changes the review rules allow land without waiting for a reviewer.
    const rule = t.focus?.waiting.length ? null : autoApproval(root, task);
    if (!rule) return { task, tally: t };
    task.review!.autoApproved = rule;
    saveTask(root, task);
    recordActivity(root, { agent: "agentbrain", task: task.id, kind: "review", text: `Approved by the review rules: ${rule}, checks pass, nothing flagged` });
    return { ...decide(root, task, "approved", `rules (${rule})`, undefined, t), tally: t };
  }
  const notes = (task.review?.votes ?? [])
    .filter((v) => v.verdict === "changes" && v.notes)
    .map((v) => (reviewPolicy(root).mode === "council" ? `${v.notes} (${v.agent})` : v.notes!))
    .join("\n") || (t.blocked ? `Make the checks pass: ${t.blocked.replace(/^checks failed: /, "")}` : undefined);
  const result = decide(root, task, t.outcome, "consensus", notes, t);
  return { ...result, tally: t };
}

function decide(
  root: string,
  task: TaskState,
  outcome: "approved" | "changes",
  decidedBy: string,
  notes: string | undefined,
  t?: Tally,
): ReviewResult {
  const review = task.review!;
  let merged: number | undefined;
  let current = task;

  if (outcome === "approved") {
    if (current.worktree) {
      saveTask(root, current);
      let result: ReturnType<typeof mergeWorktree>;
      try {
        result = mergeWorktree(root, current.id);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (!why.startsWith("Can't merge yet")) throw error;
        // The approval stands: someone's uncommitted work in the main checkout is in the way,
        // not the result. AgentBrain merges by itself once it's committed (retryPendingMerges).
        const waiting = getTask(root, current.id);
        const first = !waiting.review?.pendingMerge;
        waiting.review = { ...review, pendingMerge: { by: decidedBy, ...(notes ? { notes } : {}), at: new Date().toISOString(), why } };
        waiting.nextAction = `Approved; merges by itself once the main checkout's uncommitted changes are committed (${why.replace(/^Can't merge yet: /, "").split(" uncommitted")[0]})`;
        saveTask(root, waiting, "agentbrain");
        if (first) recordActivity(root, { agent: "agentbrain", task: current.id, kind: "review", text: `Approved by ${decidedBy.replace(/ \(override\)$/, "")}; waiting to merge: ${why.replace(/^Can't merge yet: /, "")}` });
        return { task: waiting, tally: t, pendingMerge: why };
      }
      if (result.conflicts.length) {
        // Approved but out of date: AgentBrain brings its branch up to date with main itself, leaving
        // conflict markers only in the files that really conflict, and it goes back to resolve just those.
        let conflicts = result.conflicts;
        try {
          conflicts = syncWorktree(root, current.id);
        } catch { /* the agent merges main itself */ }
        result.conflicts = conflicts.length ? conflicts : result.conflicts;
        const again = getTask(root, current.id);
        const todo = `${CONFLICT_PREFIX} ${result.conflicts.join(", ")}`;
        again.status = "handoff";
        again.remaining = [todo, ...again.remaining.filter((r) => !r.startsWith(CONFLICT_PREFIX))];
        again.nextAction = `${todo}, then set the task to review again (it was approved)`;
        delete again.review;
        saveTask(root, again, "agentbrain");
        recordActivity(root, { agent: "agentbrain", task: current.id, kind: "review", text: `Approved, but main changed the same lines (${result.conflicts.join(", ")}); brought up to date and sent back to resolve just those` });
        return { task: again, conflicts: result.conflicts, tally: t };
      }
      merged = result.merged;
      current = { ...getTask(root, current.id), review };
    }
    current.status = "done";
  } else {
    const items = (notes ?? "Rework requested").split(/\n+/).map((x) => x.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean);
    for (const item of items) if (!current.remaining.includes(item)) current.remaining.push(item);
    // The objective goes back to open: it is not finished until the reviewers say so.
    current.completed = current.completed.filter((c) => c !== current.objective);
    if (!current.remaining.includes(current.objective)) current.remaining.unshift(current.objective);
    current.nextAction = `Address the review: ${items[0]}`;
    current.status = "handoff";
  }

  // Reviewers who voted against the outcome are flagged; repeated dissent shows in their reputation.
  const flags = [...(review.flags ?? [])];
  if (decidedBy === "consensus" && reviewPolicy(root).mode === "council") {
    for (const v of (review.votes ?? []).filter((v) => reviewPolicy(root).reviewers.includes(v.agent))) {
      if (v.verdict === outcome) adjust(root, v.agent, { delta: 0.1, agreed: 1 });
      else {
        adjust(root, v.agent, { delta: -0.2, dissented: 1 });
        flags.push({ agent: v.agent, kind: "dissent", text: `Voted ${v.verdict === "approved" ? "approve" : "changes"} against the consensus (${outcome}).`, at: new Date().toISOString() });
      }
    }
  }

  current.reviews = [...(current.reviews ?? []), {
    verdict: outcome,
    reviewer: decidedBy,
    worker: review.worker,
    ...(notes ? { notes } : {}),
    votes: review.votes ?? [],
    checks: review.checks ?? [],
    flags,
    at: new Date().toISOString(),
  }];
  // With a lead (or its stand-in) one reviewer decides: name it rather than a "council".
  const mode = reviewPolicy(root).mode;
  const decider = decidedBy !== "consensus" ? decidedBy.replace(/ \(override\)$/, "")
    : mode === "council" ? "council" : (review.votes ?? []).at(-1)?.agent ?? "lead";
  const how = decidedBy !== "consensus" ? `by ${decidedBy}` : mode === "council" ? "by consensus"
    : review.standIn?.agent === decider ? `as stand-in for the lead (${review.standIn.why})` : "as the lead";
  delete current.review;
  // A send-back is the reviewer's move, not the worker stopping: autopilot (resumeSentBack) tells them apart by this.
  saveTask(root, current, outcome === "changes" ? (decider === "council" || decider === "lead" ? "agentbrain" : decider) : undefined);
  if (outcome === "approved" && current.parent) closeFinishedPlan(root, current.parent);
  recordActivity(root, {
    agent: decider,
    task: current.id,
    kind: "review",
    text: outcome === "approved"
      ? `Approved ${review.worker}'s work ${how}${merged ? `, merged ${merged} commit(s)` : ""}`
      : `Sent ${review.worker}'s work back ${how}: ${(notes ?? "").split("\n")[0]}`,
  });
  return { task: current, outcome, merged, tally: t };
}

export function closeFinishedPlan(root: string, parentId: string): void {
  const parent = getTask(root, parentId);
  if (parent.status === "done" || parent.status === "failed") return;
  const children = listTasks(root).filter((task) => task.parent === parentId);
  if (!children.length || children.some((task) => task.status !== "done")) return;
  parent.status = "done";
  parent.decisions = [...parent.decisions, `All pieces done: ${children.map((task) => task.id).join(", ")}`];
  saveTask(root, parent);
  recordActivity(root, {
    agent: "agentbrain",
    task: parent.id,
    kind: "status",
    text: `Plan complete: all ${children.length} pieces done`,
  });
}

/* ---------- what reviewers see ---------- */

/** The reviewer's packet: who did it, what they claim, what changed, checks and flags. Votes stay sealed until `viewer` has voted. */
export function reviewSummary(root: string, task: TaskState, viewer?: string): string {
  const workdir = taskWorkdir(root, task);
  const base = task.worktree?.base;
  const commits = base ? commitsSince(workdir, base) : [];
  const files = base ? git(workdir, ["diff", "--stat", `${base}...HEAD`]) : "";
  const uncommitted = git(workdir, ["status", "--short"]);
  const review = task.review;
  const lines = [
    `### ${task.id}: ${task.objective}`,
    `Finished by ${review?.worker ?? task.agent?.id ?? "unknown"}${review ? ` at ${review.requestedAt}` : ""}.`,
    task.worktree ? `Branch ${task.worktree.branch} in ${task.worktree.path}` : `Worked in the main checkout (${workdir}).`,
  ];
  if (task.completed.length) lines.push("Claims done:", ...task.completed.map((x) => `- ${x}`));
  if (task.decisions.length) lines.push("Decisions:", ...task.decisions.map((x) => `- ${x}`));
  if (task.failures.length) lines.push("Known failures:", ...task.failures.map((x) => `- ${x}`));
  if (commits.length) lines.push("Commits:", ...commits.map((c) => `- ${c}`));
  if (review?.change) {
    const kinds = { docs: "docs only", comments: "comments only", tests: "tests (and docs) only", code: "code" };
    lines.push(`Kind of change: ${kinds[review.change.kind]}, ${review.change.files} file(s)${review.autoApproved ? `; approved by the review rules (${review.autoApproved})` : ""}`);
    if (review.change.protected?.length) lines.push(`Protected files (only the developer can approve): ${review.change.protected.join(", ")}`);
  }
  if (files) lines.push("Changed:", "```", files, "```");
  if (uncommitted) lines.push("Uncommitted:", "```", uncommitted, "```");
  if (review?.checks?.length) lines.push("Checks AgentBrain ran itself:", ...review.checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.command}${c.ok ? "" : `\n${c.tail}`}`));
  else if (reviewPolicy(root).checks.length) {
    lines.push(review ? "Checks: still running." : `Checks: not run for this submission yet (agentbrain review ${task.id} --verify).`);
  }
  if (review?.flags?.length) lines.push("Flags (claims that don't match the evidence):", ...review.flags.map((f) => `- ${f.agent}: ${f.text}`));
  const t = computeTally(root, task);
  const votes = review?.votes ?? [];
  const voted = viewer ? votes.some((v) => v.agent === viewer) : true;
  if (votes.length) {
    lines.push(voted
      ? `Votes: ${votes.map((v) => `${v.agent} ${v.verdict === "approved" ? "approve" : "changes"}${v.notes ? ` (${v.notes})` : ""}`).join("; ")}`
      : `Votes: ${votes.length} cast, sealed until you vote. Judge the work yourself.`);
  }
  if (t.focus) {
    const parts = [
      ...t.focus.changes.map((f) => `${f} asked for changes`),
      ...t.focus.waiting.map((f) => `${f} still to review`),
      ...t.focus.skipped.map((f) => `${f} didn't review in time`),
    ];
    lines.push(`Focus reviews: ${parts.join("; ")}`);
  }
  if (t.eligible.length > 1) lines.push(`Reviewers: ${t.eligible.join(", ")}; quorum ${Math.round(t.quorum * 100)}% of reputation weight; survives ${t.tolerates} corrupted reviewer(s).`);
  if (task.worktree) lines.push(`Full diff: git -C ${JSON.stringify(workdir)} diff ${base}...HEAD`);
  return lines.join("\n");
}

/** Text for a reviewer's system prompt, or null when this agent doesn't review. */
export function reviewerNotice(root: string, agentId: string): string | null {
  const policy = reviewPolicy(root);
  const focus = focusReviewers(root).find((f) => f.agent === agentId);
  if (focus && !policy.reviewers.includes(agentId)) {
    const waiting = awaitingVote(root, agentId);
    const head = `You are this project's ${focus.area} reviewer${focus.paths ? ` for ${focus.paths.join(", ")}` : ""}: ` +
      `every result by other agents gets your ${focus.area} review, and only that.`;
    if (!waiting.length) return `${head} Nothing is waiting for you right now.`;
    return `${head}\n${waiting.length} result(s) waiting for your ${focus.area} review:\n` +
      waiting.map((t) => `- ${t.id} by ${t.review?.worker ?? t.agent?.id ?? "unknown"}: ${t.objective}`).join("\n") +
      `\nFor each: read the packet (agentbrain_brief with its task_id) and the diff. ${focusBrief(focus)} ` +
      "Then call agentbrain_review with verdict approve, or changes plus concrete notes.";
  }
  if (!policy.reviewers.includes(agentId)) {
    const standing = awaitingVote(root, agentId);
    if (!standing.length) return null;
    return `You are standing in for the lead (${policy.reviewers[0] ?? "none"}) on ${standing.length} result(s):\n` +
      standing.map((t) => `- ${t.id} by ${t.review?.worker ?? "unknown"} (${t.review?.standIn?.why}): ${t.objective}`).join("\n") +
      "\nFor each: read the packet (agentbrain_brief with its task_id), check the diff and the claims yourself, then call " +
      "agentbrain_review with verdict approve, or changes plus concrete notes.";
  }
  const head = policy.mode === "lead"
    ? "You are the lead agent on this project: work by other agents waits for your review before it counts as done."
    : `You are on this project's review council (${policy.reviewers.join(", ")}). Work counts as done only when a quorum ` +
      "of reviewers approves it. Judge each result independently on the evidence; other votes stay sealed until you vote.";
  const waiting = awaitingVote(root, agentId);
  if (!waiting.length) return `${head} Nothing is waiting for your review right now.`;
  return `${head}\n${waiting.length} result(s) waiting for your review:\n` +
    waiting.map((t) => `- ${t.id} by ${t.review?.worker ?? t.agent?.id ?? "unknown"}: ${t.objective}`).join("\n") +
    "\nFor each: read the packet (agentbrain_brief with its task_id), check the diff and the claims yourself, then call " +
    "agentbrain_review with verdict approve, or changes plus concrete notes.";
}

/**
 * Merges approved results that were waiting for the main checkout to be clean.
 * Runs with the control room's sweeps; returns the ids it merged.
 */
export function retryPendingMerges(root: string): string[] {
  const merged: string[] = [];
  for (const task of listTasks(root)) {
    const pending = task.status === "review" ? task.review?.pendingMerge : undefined;
    if (!pending) continue;
    const result = decide(root, task, "approved", pending.by, pending.notes);
    if (!result.pendingMerge && result.task.status === "done") merged.push(task.id);
  }
  return merged;
}

/**
 * Decides results whose outcome changed with time alone: a focus reviewer
 * that didn't review in time no longer holds a result up. Runs with the
 * control room's sweeps; returns the ids it decided.
 */
export function settleReviews(root: string): string[] {
  const settled: string[] = [];
  for (const task of pendingReviews(root)) {
    if (task.review?.pendingMerge || !focusFor(root, task).length) continue;
    try {
      const result = tally(root, task.id);
      if (result.task.status !== "review") settled.push(task.id);
    } catch { /* one bad task shouldn't stop the others */ }
  }
  return settled;
}
