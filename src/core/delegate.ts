import { spawn } from "node:child_process";
import { findTool, spawnPortable, spawnSyncPortable, vscodeCommand } from "./platform.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "../adapters/process.js";
import { ACP_AGENTS, builtinAdapter } from "../adapters/registry.js";
import { createTask } from "./actions.js";
import { readActivity, recordActivity } from "./activity.js";
import { brainDir } from "./paths.js";
import { readReputation } from "./review.js";
import { agentRecords, LIMIT_WINDOW_HOURS } from "./routing.js";
import { limitReason, quotaReason } from "./limits.js";
import type { TaskState } from "./state.js";
import { getProject, getTask, listTasks, saveProject, saveTask } from "./store.js";
import { addWorktree } from "./worktree.js";
import { localModel, ollamaBinary, ollamaModels } from "./ollama.js";

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
  if (onPath || process.env.AGENTBRAIN_ONLY_PATH) return onPath;
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
  if (process.env.AGENTBRAIN_ONLY_PATH) return findOnPath("codex");
  return findOnPath("codex") ?? (fs.existsSync("/Applications/Codex.app/Contents/Resources/codex") ? "/Applications/Codex.app/Contents/Resources/codex" : null);
}

const signInCache = new Map<string, { at: number; ok: boolean }>();

/** Asks the CLI itself whether it is signed in (cached for a minute; it costs a process). */
function signedIn(id: string, command: string): boolean {
  const cached = signInCache.get(id);
  // Signed in rarely changes: trust a yes for 10 minutes, re-check a no every minute.
  if (cached && Date.now() - cached.at < (cached.ok ? 600_000 : 60_000)) return cached.ok;
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

  // A local model through Ollama, driven by the same Claude Code harness: no quota, always there.
  const ollama = ollamaBinary();
  if (ollama) {
    const models = ollamaModels();
    const model = models ? localModel() : null;
    const ready = Boolean(claude && model && models?.some((m) => m.replace(/:latest$/, "") === model));
    workers.push({
      id: "ollama",
      name: model ? `Local model (${model})` : "Local model (Ollama)",
      how: "print",
      ...(claude ? { command: claude } : {}),
      installed: true,
      available: ready,
      ...(ready ? {} : { note: !claude ? "needs Claude Code's CLI to drive it" : models === null ? "Ollama isn't running: open the Ollama app" : "no model yet: run agentbrain local setup" }),
    });
  }

  for (const def of ACP_AGENTS) {
    if (workers.some((w) => w.id === def.id && w.installed)) continue;
    const found = findTool(def.command);
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
export const MENTIONS: Record<string, string> = {
  claude: "claude-code", "claude-code": "claude-code", ollama: "ollama", local: "ollama", codex: "codex", copilot: "vscode", vscode: "vscode", gemini: "gemini",
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
/**
 * When a usage limit says it lifts ("try again at Nov 8th, 2026 9:42 PM"), or
 * null when it doesn't say (then the usual window applies). Only dates after
 * the limit was hit count.
 */
export function limitResetsAt(reason: string, hitAt: Date): Date | null {
  const text = /try again (?:at|on|after) ([^)\n]+?)\.?$/im.exec(reason)?.[1];
  if (!text) return null;
  const when = new Date(text.replace(/(\d+)(st|nd|rd|th)\b/, "$1"));
  return Number.isNaN(when.getTime()) || when <= hitAt ? null : when;
}

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
    const limited = limitReason(root, worker.id, now) ?? quotaReason(root, worker.id, now);
    if (limited) {
      worker.available = false;
      worker.note = limited;
      return { worker, score: -1e9, reasons: [limited] };
    }
    if (project.worker === worker.id) { score += 50; reasons.push("your pinned worker"); }
    if (avoid.has(worker.id)) { score -= 1000; reasons.push("on your avoid list"); }
    const rank = prefer.indexOf(worker.id);
    if (rank !== -1) { score += 20 - rank; reasons.push("on your prefer list"); }

    const busy = tasks.filter((t) => t.status === "running" && t.agent?.id === worker.id);
    if (worker.how !== "pull") {
      if (busy.length && worker.how === "chat") {
        // A chat does one thing at a time: a second task would land in the middle of the first.
        score -= 500;
        reasons.push(`busy in its chat with ${busy[0].id}`);
      } else if (busy.length) { score -= 15 * busy.length; reasons.push(`busy with ${busy.length} task(s)`); } else reasons.push("free");
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
    const until = record?.lastLimit ? limitResetsAt(record.lastLimit.reason, record.lastLimit.at) : null;
    if (record?.lastLimit && (until ? now < until : now.getTime() - record.lastLimit.at.getTime() < LIMIT_WINDOW_HOURS * 3_600_000)) {
      // Out of quota: handing it work would only fail again (and autopilot would bounce it).
      const resets = /resets? ([^)\n.]+)/i.exec(record.lastLimit.reason)?.[1] ?? /try again (?:at|on|after) ([^)\n]+?)\.?$/i.exec(record.lastLimit.reason)?.[1];
      return { worker: { ...worker, available: false, note: `hit its usage limit${resets ? `; resets ${resets}` : ""}` }, score: -1e9, reasons: [`hit its usage limit${resets ? `, resets ${resets}` : ""}`] };
    }
    if (record?.failed) { score -= record.failed * 3; reasons.push(`${record.failed} crashed or failed run(s)`); }
    // Background runs don't need anyone at the keyboard; a chat needs VS Code open;
    // waiting for an agent to be opened is the fallback when nothing can start now.
    if (worker.how === "print" || worker.how === "headless") score += 2;
    // Free and unlimited, but a smaller model: the hosted agents go first while they have quota.
    if (worker.id === "ollama") { score -= 8; reasons.push("local model: no quota, slower and less capable"); }
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
/** What the developer last asked an agent (in the past two hours), when that agent delegates: the words behind its brief. */
export function developerRequest(root: string, agentId: string, now = Date.now()): string | undefined {
  if (agentId === "developer" || agentId === "agentbrain") return undefined;
  const asked = readActivity(root, 400).filter((e) => e.kind === "prompt" && e.agent === agentId && now - Date.parse(e.at) < 2 * 3_600_000);
  return asked.at(-1)?.text;
}

export function delegate(
  root: string,
  input: { prompt?: string; taskId?: string; worker?: string; parent?: string; requestedBy?: string; why?: string },
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
  const why = input.why ? input.why : wanted ? "you asked for it" : others ? choice.reasons.join(", ") : `the only agent ready (${choice.reasons.join(", ")})`;

  let task = input.taskId ? getTask(root, input.taskId) : createTask(root, mention.prompt ?? "", { activate: !input.parent });
  if (!input.taskId && (input.parent || input.requestedBy)) {
    const request = input.requestedBy ? developerRequest(root, input.requestedBy) : undefined;
    task = { ...task, ...(input.parent ? { parent: input.parent } : {}), ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}), ...(request ? { request } : {}) };
    saveTask(root, task);
  }
  task.delegatedTo = { worker: worker.id, at: new Date().toISOString() };
  saveTask(root, task);
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

/**
 * A big goal: a planner agent (Claude Code by default, else Codex) reads the
 * code, splits the goal into independent pieces and delegates each one; the
 * pieces run in parallel and the goal's task tracks them.
 */
export function planGoal(root: string, goal: string, self: { command: string; args: string[] }, planner?: string): DelegateResult {
  const ready = rankWorkers(root).filter((c) => c.worker.available && c.worker.how === "print");
  const choice = planner ? ready.find((c) => c.worker.id === planner) : ready.find((c) => c.worker.id === "claude-code") ?? ready[0];
  if (!choice) throw new Error("Planning needs Claude Code or Codex signed in on this machine (it reads the code and delegates the pieces).");
  const task = createTask(root, goal);
  const log = path.join(brainDir(root), "agents", `plan-${task.id}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "a");
  spawn(self.command, [...self.args, "run", choice.worker.id, task.id, "--print", "--plan"], { cwd: root, detached: true, stdio: ["ignore", fd, fd] }).unref();
  fs.closeSync(fd);
  recordActivity(root, { agent: "developer", task: task.id, kind: "handoff", text: `${choice.worker.name} is planning: ${task.objective}` });
  return { task, worker: choice.worker, why: "planner", log };
}

/**
 * Autopilot: a background run stopped early (usage limit, crash, timeout), so
 * hand the task to the next best ready agent, skipping the one that stopped.
 * At most three hand-overs per task; off with "autopilot": false in project.json.
 */
export function autoContinue(
  root: string,
  taskId: string,
  stopped: string,
  reason: string,
  self: { command: string; args: string[] },
  options: { prefer?: string; sentBack?: boolean } = {},
): DelegateResult | null {
  const project = getProject(root) as { autopilot?: boolean };
  if (project.autopilot === false) return null;
  const task = getTask(root, taskId);
  if (task.status !== "handoff") return null;
  const autopilotRuns = (task.events ?? []).filter((e) => e.status === "running" && e.agent && e.at > (task.createdAt ?? "")).length;
  if (autopilotRuns > 3) {
    recordActivity(root, { agent: "agentbrain", task: taskId, kind: "handoff", text: `Autopilot stopped: ${task.id} has been handed over ${autopilotRuns - 1} times; it waits for you` });
    return null;
  }
  // A review sending work back is not an agent failing: its event (the last one) doesn't rule anyone out.
  const handoffs = (task.events ?? []).slice(0, options.sentBack ? -1 : undefined).filter((e) => e.status === "handoff" && e.agent);
  const failedHere = new Set(handoffs.map((e) => e.agent!));
  if (!options.sentBack) failedHere.add(stopped);
  const ready = rankWorkers(root).filter((c) => c.worker.available && !failedHere.has(c.worker.id) && c.worker.how !== "pull");
  // The agent that did the work knows the code: it goes first when it can.
  const next = ready.find((c) => c.worker.id === options.prefer) ?? ready[0];
  const what = options.sentBack ? `${stopped} sent it back (${reason.slice(0, 100)})` : `${stopped} stopped (${reason.slice(0, 100)})`;
  if (!next) {
    recordActivity(root, { agent: "agentbrain", task: taskId, kind: "handoff", text: `Autopilot: ${what} and no ${options.sentBack ? "" : "other "}agent is ready; the task waits` });
    return null;
  }
  recordActivity(root, { agent: "agentbrain", task: taskId, kind: "handoff", text: `Autopilot: ${what}; handing the task to ${next.worker.name}` });
  if (options.sentBack) return delegate(root, { taskId, worker: next.worker.id, requestedBy: "agentbrain", why: `autopilot: sent back by ${stopped}` }, self);
  return delegate(root, { taskId, worker: next.worker.id, requestedBy: "agentbrain", why: `autopilot: ${stopped} stopped` }, self);
}
