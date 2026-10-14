import { execFileSync } from "node:child_process";
import path from "node:path";
import { readActivity } from "./activity.js";
import { readChangesets } from "./changeset.js";
import { gitBinary } from "./platform.js";
import { listTasks } from "./store.js";

/**
 * Who changed a file, in which task, and why: what Git can't say (it knows
 * commits, not agents, tasks or the reasons behind them). Agents ask this
 * instead of digging through history themselves.
 */

export interface FileHistory {
  file: string;
  /** Tasks working on the file right now. */
  open: { task: string; objective: string; agent?: string; status: string }[];
  /** Results that landed on main, newest first. */
  landed: { at: string; task: string; objective: string; agent?: string; commit: string; why: string[] }[];
  /** Recent edits by any agent, newest first. */
  edits: { at: string; agent: string; task?: string; text: string }[];
  /** Recent commits to the file, newest first. */
  commits: string[];
}

export function normalizePath(root: string, file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
  return rel.split(path.sep).join("/").replace(/^\.\//, "");
}

export function fileHistory(root: string, file: string, limit = 8): FileHistory {
  const target = normalizePath(root, file);
  const tasks = new Map(listTasks(root).map((t) => [t.id, t]));
  const same = (f: string) => normalizePath(root, f) === target;

  const landed = readChangesets(root)
    .filter((cs) => cs.files.some((f) => same(f.path)))
    .reverse()
    .slice(0, limit)
    .map((cs) => {
      const task = tasks.get(cs.task);
      return {
        at: cs.at, task: cs.task, objective: task?.objective.split("\n")[0] ?? "", ...(cs.agent ? { agent: cs.agent } : {}),
        commit: cs.commit.slice(0, 9), why: (task?.decisions ?? []).slice(-3),
      };
    });

  const touching = readActivity(root, 5000).filter((e) => e.kind === "edit" && (e.files ?? []).some(same)).reverse();
  const edits = touching.slice(0, limit).map((e) => ({ at: e.at, agent: e.agent, ...(e.task ? { task: e.task } : {}), text: e.text }));
  const open = [...new Set(touching.map((e) => e.task).filter((id): id is string => Boolean(id)))]
    .map((id) => tasks.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t) && !["done", "failed"].includes(t!.status))
    .map((t) => ({ task: t.id, objective: t.objective.split("\n")[0], ...(t.agent?.id ? { agent: t.agent.id } : {}), status: t.status }));

  let commits: string[] = [];
  try {
    commits = execFileSync(gitBinary(), ["log", `-${limit}`, "--format=%h %ad %an: %s", "--date=short", "--", target], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean);
  } catch { /* not a Git repository */ }

  return { file: target, open, landed, edits, commits };
}

export function formatHistory(h: FileHistory): string {
  const lines = [`# ${h.file}`];
  if (h.open.length) lines.push("", "Being worked on now:", ...h.open.map((o) => `- ${o.task} (${o.status}${o.agent ? `, ${o.agent}` : ""}): ${o.objective}`));
  if (h.landed.length) {
    lines.push("", "Results that changed it (newest first):");
    for (const l of h.landed) {
      lines.push(`- ${l.at.slice(0, 10)} ${l.task}${l.agent ? ` by ${l.agent}` : ""} (${l.commit}): ${l.objective}`);
      for (const w of l.why) lines.push(`    why: ${w}`);
    }
  }
  if (h.edits.length) lines.push("", "Recent edits:", ...h.edits.map((e) => `- ${e.at.slice(0, 16).replace("T", " ")} ${e.agent}${e.task ? ` (${e.task})` : ""}: ${e.text}`));
  if (h.commits.length) lines.push("", "Commits:", ...h.commits.map((c) => `- ${c}`));
  if (lines.length === 1) lines.push("", "No agent has changed it through AgentBrain, and Git has no commits for it.");
  return lines.join("\n");
}
