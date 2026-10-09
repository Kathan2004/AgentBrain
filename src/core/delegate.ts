import { spawn } from "node:child_process";
import { spawnPortable, spawnSyncPortable, vscodeCommand } from "./platform.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "../adapters/process.js";
import { ACP_AGENTS, builtinAdapter } from "../adapters/registry.js";
import { createTask } from "./actions.js";
import { recordActivity } from "./activity.js";
import { brainDir } from "./paths.js";
import { readReputation } from "./review.js";
import { agentRecords, LIMIT_WINDOW_HOURS } from "./routing.js";
import type { TaskState } from "./state.js";
import { getProject, getTask, listTasks, saveProject, saveTask } from "./store.js";
import { addWorktree } from "./worktree.js";

/**
 * Hands a prompt to an agent without opening anything new: the developer types
 * what they want (in the console or the control room) and AgentBrain turns it
 * into a task, gives it its own worktree, picks the agent best placed to do it
 * right now, and starts it in the background (or in a chat that is already open).
 */
export interface Worker {
  id: string;
  name: string;
  /**
   * "chat": sent to the open VS Code chat; "print": an agent CLI run
   * non-interactively (claude -p, codex exec); "headless": an ACP agent;
   * "pull": waits for whichever agent the developer opens next (Claude app,
   * Cursor, VS Code extensions…), which picks it up over MCP.
   */
  how: "chat" | "print" | "headless" | "pull";
  /** The executable, when found. */
  command?: string;
  installed: boolean;
  /** Installed and ready (signed in). */
  available: boolean;
  /** Why it isn't available, and how to fix it. */
  note?: string;
}

/** Claude Code's CLI: on PATH, or the copy the Claude desktop app ships with. */
export function claudeBinary(): string | null {
  const onPath = findOnPath("claude");
  if (onPath) return onPath;
  const base = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = fs.readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const file = path.join(base, version, "claude.app", "Contents", "MacOS", "claude");
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // no desktop app
  }
  return null;
}

/** Codex's CLI: on PATH, or the copy inside Codex.app. */
export function codexBinary(): string | null {
  return findOnPath("codex") ?? (fs.existsSync("/Applications/Codex.app/Contents/Resources/codex") ? "/Applications/Codex.app/Contents/Resources/codex" : null);
}

const signInCache = new Map<string, { at: number; ok: boolean }>();

/** Asks the CLI itself whether it is signed in (cached for a minute; it costs a process). */
function signedIn(id: string, command: string): boolean {
  const cached = signInCache.get(id);
  if (cached && Date.now() - cached.at < 60_000) return cached.ok;
  let ok = false;
  try {
    if (id === "claude-code") {
      const result = spawnSyncPortable(command, ["auth", "status"], { encoding: "utf8", timeout: 10_000 });
      ok = /"loggedIn"\s*:\s*true/.test(String(result.stdout ?? ""));
    } else if (id === "codex") {
      const result = spawnSyncPortable(command, ["login", "status"], { encoding: "utf8", timeout: 10_000 });
      ok = result.status === 0 && !/not logged in/i.test(`${result.stdout}${result.stderr}`);
    } else ok = true;
  } catch {
    ok = false;
  }
  signInCache.set(id, { at: Date.now(), ok });
  return ok;
}

export function listWorkers(): Worker[] {
  const workers: Worker[] = [];
  const vscode = builtinAdapter("vscode");
  const code = Boolean(vscode?.available());
  workers.push({ id: "vscode", name: "Copilot (VS Code)", how: "chat", installed: code, available: code, ...(code ? {} : { note: "VS Code's `code` command was not found" }) });

  const quote = (file: string) => (file.includes(" ") ? JSON.stringify(file) : file);
  const claude = claudeBinary();
  const claudeOk = Boolean(claude && signedIn("claude-code", claude));
  workers.push({
    id: "claude-code",
    name: "Claude Code",
    how: "print",
    ...(claude ? { command: claude } : {}),
    installed: Boolean(claude),
    available: claudeOk,
    ...(!claude ? { note: "not installed" } : claudeOk ? {} : { note: `not signed in: run ${quote(claude)} auth login` }),
  });

  const codex = codexBinary();
  const codexOk = Boolean(codex && signedIn("codex", codex));
  workers.push({
    id: "codex",
    name: "Codex",
    how: "print",
    ...(codex ? { command: codex } : {}),
    installed: Boolean(codex),
    available: codexOk,
    ...(!codex ? { note: "not installed" } : codexOk ? {} : { note: `not signed in: run ${quote(codex)} login` }),
  });

  for (const def of ACP_AGENTS) {
    if (workers.some((w) => w.id === def.id && w.installed)) continue;
    const found = findOnPath(def.command);
    const existing = workers.findIndex((w) => w.id === def.id);
    const worker: Worker = {
      id: def.id,
      name: def.name.replace(/ \(.*\)$/, ""),
      how: "headless",
      ...(found ? { command: found } : {}),
      installed: Boolean(found),
      available: Boolean(found),
      ...(found ? {} : { note: "not installed" }),
    };
    if (existing >= 0) {
      if (found) workers[existing] = worker;
    } else workers.push(worker);
  }
  workers.push({
    id: "any",
    name: "Next agent you open",
    how: "pull",
    installed: true,
    available: true,
  });
  return workers;
}

export function workerName(id: string): string {
  return listWorkers().find((w) => w.id === id)?.name ?? id;
}

/** Explicit "@agent" at the start of a prompt picks the worker. */
const MENTIONS: Record<string, string> = {
  claude: "claude-code", "claude-code": "claude-code", codex: "codex", copilot: "vscode", vscode: "vscode", gemini: "gemini",
  any: "any", cursor: "any", app: "any",
};

export function parseMention(prompt: string): { worker?: string; prompt: string } {
  const match = /^@([a-z-]+)\s+/i.exec(prompt.trim());
  const worker = match ? MENTIONS[match[1].toLowerCase()] : undefined;
  return worker ? { worker, prompt: prompt.trim().slice(match![0].length) } : { prompt };
}

export interface WorkerChoice {
  worker: Worker;
  score: number;
  reasons: string[];
}

/**
 * Ranks the workers for a task from what AgentBrain has seen in this project:
 * who is free, whose results reviewers approved or sent back, reputation,
 * recent usage limits and crashes, and the developer's preferences. No
 * guesses about which model is "smarter".
 */
export function rankWorkers(root: string, now = new Date()): WorkerChoice[] {
  const project = getProject(root);
  const records = agentRecords(root);
  const reputation = readReputation(root);
  const tasks = listTasks(root);
  const prefer = project.agents?.prefer ?? [];
  const avoid = new Set(project.agents?.avoid ?? []);

  return listWorkers().map((worker) => {
    let score = 0;
    const reasons: string[] = [];
    if (!worker.available) {
      return { worker, score: -1e9, reasons: [worker.note ?? "not available"] };
    }
    if (project.worker === worker.id) { score += 50; reasons.push("your pinned worker"); }
    if (avoid.has(worker.id)) { score -= 1000; reasons.push("on your avoid list"); }
    const rank = prefer.indexOf(worker.id);
    if (rank !== -1) { score += 20 - rank; reasons.push("on your prefer list"); }

    const busy = tasks.filter((t) => t.status === "running" && t.agent?.id === worker.id);
    if (worker.how !== "pull") {
      if (busy.length) { score -= 15 * busy.length; reasons.push(`busy with ${busy.length} task(s)`); } else reasons.push("free");
    }

    let approved = 0;
    let sentBack = 0;
    for (const t of tasks) for (const r of t.reviews ?? []) if (r.worker === worker.id) r.verdict === "approved" ? approved++ : sentBack++;
    if (approved + sentBack) {
      score += approved * 4 - sentBack * 3;
      reasons.push(`${approved} approved, ${sentBack} sent back in this project`);
    }
    const rep = reputation[worker.id];
    if (rep && rep.score !== 1) { score += (rep.score - 1) * 10; reasons.push(`reputation ${rep.score.toFixed(2)}`); }

    const record = records.get(worker.id);
    if (record?.lastLimit && now.getTime() - record.lastLimit.at.getTime() < LIMIT_WINDOW_HOURS * 3_600_000) {
      score -= 100;
      reasons.push("hit a usage limit recently");
    }
    if (record?.failed) { score -= record.failed * 3; reasons.push(`${record.failed} crashed or failed run(s)`); }
    // Background runs don't need anyone at the keyboard; a chat needs VS Code open;
    // waiting for an agent to be opened is the fallback when nothing can start now.
    if (worker.how === "print" || worker.how === "headless") score += 2;
    if (worker.how === "pull") { score -= 20; reasons.push("waits until you open an agent on this repo: Claude app, Cursor, VS Code extensions"); }
    return { worker, score, reasons };
  }).sort((a, b) => b.score - a.score || a.worker.id.localeCompare(b.worker.id));
}

export function setDefaultWorker(root: string, id: string): string {
  const project = getProject(root);
  if (id === "auto") {
    delete project.worker;
    saveProject(root, project);
    return "auto";
  }
  const worker = listWorkers().find((w) => w.id === id || w.name.toLowerCase() === id.toLowerCase()) ??
    listWorkers().find((w) => w.id === MENTIONS[id.toLowerCase()]);
  if (!worker) throw new Error(`Unknown worker "${id}". Workers: auto, ${listWorkers().map((w) => w.id).join(", ")}`);
  if (!worker.available) throw new Error(`${worker.name} can't take work: ${worker.note}.`);
  project.worker = worker.id;
  saveProject(root, project);
  return worker.name;
}

function isGitRepo(root: string): boolean {
  return fs.existsSync(path.join(root, ".git"));
}

export interface DelegateResult {
  task: TaskState;
  worker: Worker;
  /** Why this worker, in a few words. */
  why: string;
  log: string;
}

/**
 * Starts work on `taskId` (or a new task for `prompt`) with a worker: the one
 * named (or @mentioned), else the best-ranked one. The dispatch runs as a
 * separate AgentBrain process so the caller never blocks on the agent; its
 * outcome shows up in the activity feed and task state.
 */
export function delegate(
  root: string,
  input: { prompt?: string; taskId?: string; worker?: string; parent?: string; requestedBy?: string },
  self: { command: string; args: string[] },
): DelegateResult {
  const mention: { worker?: string; prompt?: string } = input.prompt ? parseMention(input.prompt) : {};
  // An @mention in the prompt beats the selected agent.
  const wanted = mention.worker ?? input.worker;
  const ranked = rankWorkers(root);
  let choice: WorkerChoice | undefined;
  if (wanted) {
    choice = ranked.find((c) => c.worker.id === wanted);
    if (!choice?.worker.available) {
      throw new Error(`${choice?.worker.name ?? wanted} can't take work: ${choice?.worker.note ?? "unknown agent"}.`);
    }
  } else choice = ranked.find((c) => c.worker.available);
  if (!choice) {
    const fixes = ranked.filter((c) => c.worker.installed && c.worker.note).map((c) => `${c.worker.name}: ${c.worker.note}`);
    throw new Error(`No agent can take work yet. ${fixes.length ? fixes.join("; ") : "Open VS Code with Copilot, or install Claude Code or Codex."}`);
  }
  const { worker } = choice;
  const others = ranked.filter((c) => c !== choice && c.worker.available).length;
  const why = wanted ? "you asked for it" : others ? choice.reasons.join(", ") : `the only agent ready (${choice.reasons.join(", ")})`;

  let task = input.taskId ? getTask(root, input.taskId) : createTask(root, mention.prompt ?? "", { activate: !input.parent });
  if (!input.taskId && (input.parent || input.requestedBy)) {
    task = { ...task, ...(input.parent ? { parent: input.parent } : {}), ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}) };
    saveTask(root, task);
  }
  // Parallel work never collides: each delegated task gets its own checkout.
  if (!task.worktree && isGitRepo(root) && task.status !== "done") task = addWorktree(root, task.id);

  if (worker.how === "pull") {
    recordActivity(root, { agent: input.requestedBy ?? "developer", task: task.id, kind: "handoff", text: `Waiting for the next agent you open on this repo: ${task.objective}` });
    return { task, worker, why, log: "" };
  }
  const args = worker.how === "chat"
    ? [...self.args, "run", worker.id, task.id, "--here"]
    : worker.how === "print"
      ? [...self.args, "run", worker.id, task.id, "--print"]
      : [...self.args, "run", worker.id, task.id, "--headless", "--detach"];
  const log = path.join(brainDir(root), "agents", `delegate-${task.id}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  const child = spawn(self.command, args, { cwd: root, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.closeSync(fd);
  recordActivity(root, {
    agent: input.requestedBy ?? "developer",
    task: task.id,
    kind: "handoff",
    text: `Delegated to ${worker.name} (${why}): ${task.objective}`,
  });
  return { task, worker, why, log };
}

/**
 * Copilot only hears what is typed into its chat. When a message is for it (or
 * everyone) and it isn't in the middle of a task, put the message in the chat;
 * while it works, it gets the message in its next AgentBrain tool result instead.
 */
export function deliverToChat(root: string, message: { from: string; to: string; text: string }): boolean {
  if (message.from === "vscode" || (message.to !== "vscode" && message.to !== "all")) return false;
  const vscode = builtinAdapter("vscode");
  if (!vscode?.available()) return false;
  const busy = listTasks(root).some((t) => t.status === "running" && t.agent?.id === "vscode");
  if (busy) return false;
  const code = vscodeCommand();
  if (!code) return false;
  const child = spawnPortable(code, ["chat", "--mode", "agent", "--reuse-window",
    `Message from ${message.from} through AgentBrain: ${message.text}\n\nReply with the agentbrain_message tool (to: "${message.from}") if a reply is useful.`],
  { cwd: root, detached: true, stdio: "ignore" });
  child.unref();
  return true;
}
