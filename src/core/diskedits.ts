import path from "node:path";
import { readActivity, recordActivity } from "./activity.js";
import { getProject, listSessions } from "./store.js";
import { hookedAgents } from "./agenthooks.js";

/**
 * Edits nobody reported. Claude Code tells AgentBrain about every edit through
 * its hooks, but an editor without hooks (Cursor, Copilot in VS Code, you by
 * hand) changes files silently. The daemon watches the project, and when a
 * source file changes and no agent reports it within a few seconds, it records
 * the edit itself, credited to the most likely editor and marked as seen on disk.
 */

/** Agents that report their own edits; a change they made shows up without help. */
const HOOKED = new Set(["claude-code", "ollama", "codex"]);
const SETTLE_MS = 4_000;
const SKIP = /(^|\/)(\.git|node_modules|dist|coverage|\.next|\.turbo|\.cache)(\/|$)|\.(log|lock|tmp|swp)$|\.tmp\.|~$/;

/** The project path and task of a changed file, or null when it isn't project source (AgentBrain's own state, build output…). */
export function editTarget(root: string, absFile: string): { rel: string; task?: string } | null {
  const rel = path.relative(root, absFile).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return null;
  const wt = /^\.agentbrain\/worktrees\/([^/]+)\/(.+)$/.exec(rel);
  if (wt) return SKIP.test(wt[2]) ? null : { rel: wt[2], task: wt[1] };
  if (rel.startsWith(".agentbrain/") || /^\.[^/]+\//.test(rel) || SKIP.test(rel)) return null;
  return { rel };
}

/**
 * A hooked agent in the middle of a turn: its shell commands (a build, a script
 * writing files) change files before its hook reports the command, so an
 * unreported edit right now is most likely its, not someone else's.
 */
function hookedAgentBusy(root: string, now = Date.now()): boolean {
  const hooked = new Set([...HOOKED, ...hookedAgents(root)]);
  return listSessions(root).some((s) => !s.endedAt && hooked.has(s.agentId) && s.activity === "working" && now - Date.parse(s.lastSeenAt ?? s.startedAt) < 10 * 60_000);
}

/** Who most likely made an edit no agent reported. */
export function likelyEditor(root: string, now = Date.now()): string {
  const hooked = new Set([...HOOKED, ...hookedAgents(root)]);
  const recent = listSessions(root)
    .filter((s) => !s.endedAt && !hooked.has(s.agentId) && s.mode !== "headless" && now - Date.parse(s.lastSeenAt ?? s.startedAt) < 30 * 60_000)
    .sort((a, b) => (b.lastSeenAt ?? b.startedAt).localeCompare(a.lastSeenAt ?? a.startedAt));
  if (recent[0]) return recent[0].agentId;
  const lead = getProject(root).lead;
  if (lead && !hooked.has(lead)) return lead;
  return "developer";
}

/** Whether an agent already accounted for this change: it reported the edit, or ran a command there just now. */
function reported(root: string, target: { rel: string; task?: string }, since: number): boolean {
  return readActivity(root, 300).some((e) => {
    const at = Date.parse(e.at);
    if (at < since) return false;
    if (e.kind === "edit" && e.files?.some((f) => f === target.rel || f.endsWith(`/${target.rel}`) || target.rel.endsWith(`/${f}`))) return true;
    // A hooked agent's shell command (sed, a script, a build) changes files without an edit event.
    return e.kind === "command" && HOOKED.has(e.agent) && (e.task ?? "") === (target.task ?? e.task ?? "");
  });
}

/** Watches for unreported edits; feed it every changed path. Returns a stop function. */
export function diskEditRecorder(root: string, settleMs = SETTLE_MS): { changed: (absFile: string) => void; stop: () => void } {
  const pending = new Map<string, NodeJS.Timeout>();
  const recorded = new Map<string, number>();
  const changed = (absFile: string) => {
    const target = editTarget(root, absFile);
    if (!target) return;
    const key = `${target.task ?? ""}:${target.rel}`;
    const first = Date.now();
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      // One note per file per minute: a save storm is one edit.
      if (Date.now() - (recorded.get(key) ?? 0) < 60_000) return;
      if (reported(root, target, first - 30_000)) return;
      // Unless an agent without hooks is working too, a busy hooked agent made it (its hook reports the command later).
      const unhookedWorking = listSessions(root).some((x) => !x.endedAt && x.activity === "working" && !new Set([...HOOKED, ...hookedAgents(root)]).has(x.agentId) && Date.now() - Date.parse(x.lastSeenAt ?? x.startedAt) < 10 * 60_000);
      if (hookedAgentBusy(root) && !unhookedWorking) return;
      recorded.set(key, Date.now());
      recordActivity(root, {
        agent: likelyEditor(root),
        ...(target.task ? { task: target.task } : {}),
        kind: "edit",
        text: `Edited ${target.rel} (seen on disk; no agent reported it)`,
        files: [target.rel],
      });
    }, settleMs));
  };
  const stop = () => { pending.forEach((t) => clearTimeout(t)); pending.clear(); };
  return { changed, stop };
}
