import { execFileSync } from "node:child_process";
import path from "node:path";
import { readActivity } from "./activity.js";
import { readChangesets } from "./changeset.js";
import { normalizePath } from "./history.js";
import { gitBinary } from "./platform.js";
import type { ReviewVerdict, TaskState } from "./state.js";
import { listTasks } from "./store.js";

/**
 * The audit trail: for everything that landed, who wrote it (agent, model or
 * bot), what the developer asked for, which checks ran, who approved it and
 * how, what was sent back first, the flags raised, and the reasons recorded.
 * And for a file, which of those wrote each of its lines. Built from what
 * AgentBrain already records; nothing extra is kept for it.
 */

export interface AuditEntry {
  at: string;
  task: string;
  objective: string;
  /** The agent, model tier or bot that did the work. */
  worker: string;
  model?: string;
  /** A bot's branch or a script, when the work was automation. */
  gated?: { by: string; ref?: string; command?: string };
  /** The developer's own words, when the work came from a request. */
  request?: string;
  kind?: string;
  files: string[];
  /** The commit it landed as on main (absent for tasks merged before landings were recorded). */
  commit?: string;
  approval: { how: "lead" | "council" | "rules" | "developer" | "stand-in" | "none"; by: string[]; at?: string };
  checks: { command: string; ok: boolean }[];
  sentBack: { by: string; notes?: string; at: string }[];
  flags: string[];
  decisions: string[];
}

/** Who reached a verdict: the reviewers who voted for it ("consensus" names no one), or the developer. */
function deciders(r: ReviewVerdict, verdict: "approved" | "changes"): string {
  const voters = (r.votes ?? []).filter((v) => v.verdict === verdict).map((v) => v.agent);
  return r.reviewer === "consensus" && voters.length ? voters.join(", ") : r.reviewer.replace(/ \(override\)$/, "");
}

function approvalOf(task: TaskState): AuditEntry["approval"] {
  const final = [...(task.reviews ?? [])].reverse().find((r) => r.verdict === "approved");
  if (!final) return { how: "none", by: [] };
  if (/^rules \(/.test(final.reviewer)) return { how: "rules", by: [final.reviewer.replace(/^rules \((.*)\)$/, "$1")], at: final.at };
  if (/ \(override\)$/.test(final.reviewer)) return { how: "developer", by: [final.reviewer.replace(/ \(override\)$/, "")], at: final.at };
  const approvers = (final.votes ?? []).filter((v) => v.verdict === "approved").map((v) => v.agent);
  const standIn = task.review?.standIn?.agent;
  const how = approvers.length > 1 ? "council" : standIn && approvers.includes(standIn) ? "stand-in" : "lead";
  return { how, by: approvers, at: final.at };
}

/** A task's objective in a line: briefs can run to pages. */
function brief(objective: string): string {
  const line = objective.split("\n")[0].trim();
  const sentence = /^(.{20,}?[.!?])\s/.exec(line)?.[1] ?? line;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence;
}

function entryFor(task: TaskState, landed?: { at: string; agent?: string; model?: string; commit: string; files: string[]; kind?: string }): AuditEntry {
  const final = [...(task.reviews ?? [])].reverse().find((r) => r.verdict === "approved");
  const worker = landed?.agent ?? final?.worker ?? task.review?.worker ?? task.agent?.id ?? "unknown";
  return {
    at: landed?.at ?? task.merged?.at ?? task.updatedAt ?? "",
    task: task.id,
    objective: brief(task.objective),
    worker,
    ...(landed?.model ? { model: landed.model } : {}),
    ...(task.gated ? { gated: { by: task.gated.by, ...(task.gated.ref ? { ref: task.gated.ref } : {}), ...(task.gated.command ? { command: task.gated.command } : {}) } } : {}),
    ...(task.request ? { request: task.request } : {}),
    ...(landed?.kind ?? task.review?.change?.kind ? { kind: landed?.kind ?? task.review?.change?.kind } : {}),
    files: landed?.files ?? task.merged?.files ?? [],
    ...(landed?.commit ?? task.merged?.landed ? { commit: landed?.commit ?? task.merged?.landed } : {}),
    approval: approvalOf(task),
    checks: (final?.checks ?? task.review?.checks ?? []).map((c) => ({ command: c.command, ok: c.ok })),
    sentBack: (task.reviews ?? []).filter((r) => r.verdict === "changes").map((r) => ({ by: deciders(r, "changes"), ...(r.notes ? { notes: r.notes } : {}), at: r.at })),
    flags: [...new Map([...(task.reviews ?? []).flatMap((r) => r.flags ?? []), ...(task.review?.flags ?? [])].map((f) => [`${f.agent}:${f.kind}:${f.text}`, `${f.agent}: ${f.text}`])).values()],
    decisions: task.decisions,
  };
}

/** Everything that landed, newest first; `since` an ISO date, `file` only results that changed it. */
export function auditTrail(root: string, options: { since?: string; file?: string } = {}): AuditEntry[] {
  const tasks = new Map(listTasks(root).map((t) => [t.id, t]));
  const entries: AuditEntry[] = [];
  const seen = new Set<string>();
  for (const cs of readChangesets(root)) {
    const task = tasks.get(cs.task);
    if (!task) continue;
    seen.add(task.id);
    entries.push(entryFor(task, { at: cs.at, ...(cs.agent ? { agent: cs.agent } : {}), ...(cs.model ? { model: cs.model } : {}), commit: cs.commit, files: cs.files.map((f) => f.path), ...(cs.kind ? { kind: cs.kind } : {}) }));
  }
  // Results merged before landings were recorded.
  for (const task of tasks.values()) if (!seen.has(task.id) && task.merged) entries.push(entryFor(task));
  const file = options.file ? normalizePath(root, options.file) : undefined;
  return entries
    .filter((e) => !options.since || e.at >= options.since)
    .filter((e) => !file || e.files.some((f) => normalizePath(root, f) === file))
    .sort((a, b) => b.at.localeCompare(a.at));
}

const HOW: Record<AuditEntry["approval"]["how"], string> = {
  lead: "the lead", council: "the council", rules: "the review rules", developer: "the developer", "stand-in": "a stand-in for the lead", none: "nobody (no review was required)",
};

export function formatAudit(entries: AuditEntry[], title = "AgentBrain audit trail"): string {
  const by = new Map<string, number>();
  for (const e of entries) by.set(e.worker, (by.get(e.worker) ?? 0) + 1);
  const lines = [`# ${title}`, "", `${entries.length} result(s) landed${by.size ? `: ${[...by].map(([w, n]) => `${w} ${n}`).join(", ")}` : ""}.`];
  for (const e of entries) {
    lines.push("", `## ${e.at.slice(0, 16).replace("T", " ")} · ${e.task}: ${e.objective}`);
    lines.push(`- Written by: ${e.worker}${e.model ? ` (${e.model})` : ""}${e.gated ? ` — automation: ${e.gated.ref ?? e.gated.command}` : ""}`);
    if (e.request) lines.push(`- Asked for: "${e.request}"`);
    if (e.files.length) lines.push(`- Files (${e.files.length}${e.kind ? `, ${e.kind}` : ""}): ${e.files.slice(0, 12).join(", ")}${e.files.length > 12 ? ", …" : ""}`);
    lines.push(`- Checks: ${e.checks.length ? e.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.command}`).join("; ") : "none ran"}`);
    lines.push(`- Approved by ${HOW[e.approval.how]}${e.approval.by.length ? `: ${e.approval.by.join(", ")}` : ""}`);
    for (const s of e.sentBack) lines.push(`- Sent back first by ${s.by}${s.notes ? `: ${s.notes.split("\n")[0].slice(0, 200)}` : ""}`);
    for (const f of e.flags) lines.push(`- Flag: ${f}`);
    for (const d of e.decisions.slice(-4)) lines.push(`- Why: ${d}`);
    if (e.commit) lines.push(`- Landed as ${e.commit.slice(0, 12)}`);
  }
  return lines.join("\n");
}

export interface LineAttribution {
  from: number;
  to: number;
  commit: string;
  /** Agent, model tier or bot; else the commit's author. */
  by: string;
  model?: string;
  task?: string;
  approvedBy?: string;
}

/** Who wrote each line of a file: consecutive lines from the same commit form one range. */
export function auditFile(root: string, file: string): LineAttribution[] {
  const rel = normalizePath(root, file);
  let blame: string;
  try {
    blame = execFileSync(gitBinary(), ["blame", "--line-porcelain", "HEAD", "--", rel], { cwd: root, encoding: "utf8", maxBuffer: 200_000_000 });
  } catch {
    throw new Error(`Git has no history for ${rel}.`);
  }
  const landed = new Map(readChangesets(root).map((cs) => [cs.commit, cs]));
  const tasks = new Map(listTasks(root).map((t) => [t.id, t]));
  // Commits AgentBrain saw an agent make (in the main checkout, or before landings were recorded).
  const committed = new Map<string, { agent: string; task?: string }>();
  for (const e of readActivity(root, 20_000)) {
    if (e.kind === "commit") committed.set(e.text.split(" ")[0], { agent: e.agent, ...(e.task ? { task: e.task } : {}) });
  }
  const merged = new Map([...tasks.values()].filter((t) => t.merged?.landed).map((t) => [t.merged!.landed!, t]));

  const ranges: LineAttribution[] = [];
  let sha = "";
  let author = "";
  for (const line of blame.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (head) { sha = head[1]; continue; }
    if (line.startsWith("author ")) { author = line.slice(7); continue; }
    if (!line.startsWith("\t")) continue;
    const n = ranges.length ? ranges.at(-1)!.to + 1 : 1;
    const last = ranges.at(-1);
    if (last && last.commit === sha) { last.to = n; continue; }
    const cs = landed.get(sha);
    const seen = [...committed].find(([short]) => sha.startsWith(short))?.[1];
    const task = cs ? tasks.get(cs.task) : seen?.task ? tasks.get(seen.task) : merged.get(sha);
    const approval = task ? approvalOf(task) : undefined;
    ranges.push({
      from: n, to: n, commit: sha,
      by: cs?.agent ?? (seen && seen.agent !== "developer" ? seen.agent : undefined) ?? task?.agent?.id ?? author,
      ...(cs?.model ? { model: cs.model } : {}),
      ...(task ? { task: task.id } : {}),
      ...(approval && approval.how !== "none" ? { approvedBy: `${HOW[approval.how]}${approval.by.length ? ` (${approval.by.join(", ")})` : ""}` } : {}),
    });
  }
  return ranges;
}

export function formatFileAudit(root: string, file: string, ranges: LineAttribution[]): string {
  const rel = normalizePath(root, file);
  const total = ranges.reduce((s, r) => s + r.to - r.from + 1, 0);
  const share = new Map<string, number>();
  for (const r of ranges) share.set(r.by, (share.get(r.by) ?? 0) + r.to - r.from + 1);
  const lines = [`# Who wrote ${path.basename(rel)} (${rel}, ${total} lines)`, "",
    [...share].sort((a, b) => b[1] - a[1]).map(([by, n]) => `${by} ${Math.round((n / Math.max(total, 1)) * 100)}%`).join(" · "), ""];
  for (const r of ranges) {
    lines.push(`- lines ${r.from}${r.to > r.from ? `–${r.to}` : ""}: ${r.by}${r.model ? ` (${r.model})` : ""}${r.task ? ` in ${r.task}` : ""}${r.approvedBy ? `, approved by ${r.approvedBy}` : ""} · ${r.commit.slice(0, 9)}`);
  }
  return lines.join("\n");
}
