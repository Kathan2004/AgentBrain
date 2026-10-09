/**
 * `agentbrain` with no arguments: the AgentBrain console. It looks and works
 * like an agent CLI — a welcome box, a transcript, and a prompt box at the
 * bottom — but what you type is delegated: each prompt becomes a task that an
 * agent picks up, and the console streams what the agents do, brings finished
 * work back for review, and takes slash commands for everything else.
 *
 * Rendering helpers are pure (exported for tests); runConsole does the I/O.
 */
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { activityFile, type ActivityEvent } from "../core/activity.js";
import { delegate, deliverToChat, rankWorkers, setDefaultWorker } from "../core/delegate.js";
import { sendMessage } from "../core/messages.js";
import {
  computeTally,
  faultTolerance,
  pendingReviews,
  readReputation,
  reviewPolicy,
  reviewSummary,
  reviewTask,
  setChecks,
  setCouncil,
  setLead,
} from "../core/review.js";
import type { TaskState } from "../core/state.js";
import { getProject, getTask, listSessions, listTasks } from "../core/store.js";
import { openBrowser, startUiDaemon } from "./daemon.js";
import { fit, visibleLength } from "./tui.js";

// ---------------------------------------------------------------- styling

const ESC = "\x1b[";
const paint = (code: string) => (text: string) => `${ESC}${code}m${text}${ESC}0m`;
export const style = {
  dim: paint("2"),
  bold: paint("1"),
  accent: paint("38;5;75"), // calm blue accent
  green: paint("32"),
  red: paint("31"),
  yellow: paint("33"),
  blue: paint("34"),
  purple: paint("35"),
  cyan: paint("36"),
  invert: paint("7"),
};
export function agentLabel(id: string): string {
  const names: Record<string, string> = {
    "claude-code": "Claude Code",
    vscode: "Copilot (VS Code)",
    codex: "Codex",
    gemini: "Gemini",
    cursor: "Cursor",
    copilot: "Copilot CLI",
    developer: "You",
    agentbrain: "AgentBrain",
    council: "Council",
  };
  return names[id] ?? id;
}

function agentColor(id: string): (t: string) => string {
  if (id === "developer") return style.bold;
  return style.accent;
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------- pure rendering

export interface WelcomeInfo {
  root: string;
  worker: string | null;
  decides: string;
  running: number;
  review: number;
}

export function welcomeBox(width: number, info: WelcomeInfo): string[] {
  const w = Math.max(40, Math.min(width, 100));
  const home = os.homedir();
  const cwd = info.root.startsWith(home) ? `~${info.root.slice(home.length)}` : info.root;
  return [
    fit(` ${style.bold("AgentBrain")} ${style.dim("·")} ${style.dim(cwd)} ${style.dim("· worker")} ${info.worker ?? style.yellow("none available")}`, w),
    fit(` ${style.dim("decides")} ${info.decides} ${style.dim("·")} ${info.running} running ${style.dim("·")} ${info.review ? style.accent(`${info.review} to review`) : "nothing to review"}`, w),
    "",
  ];
}

export interface InputRender {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

const PLACEHOLDER = "Describe a task for your agents, or type / for commands";

/** A quiet prompt line; long input wraps to the terminal width. */
export function inputBox(width: number, buffer: string, cursor: number): InputRender {
  const w = Math.max(20, width);
  const tw = w - 2;
  const chars = [...buffer];
  const rows = Math.max(1, Math.floor(chars.length / tw) + 1);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const text = chars.slice(r * tw, (r + 1) * tw).join("");
    const prefix = r === 0 ? `${style.accent(">")} ` : "  ";
    const body = !buffer && r === 0 ? style.dim(PLACEHOLDER.slice(0, tw)) : text;
    lines.push(fit(`${prefix}${body}`, w));
  }
  return { lines, cursorRow: Math.floor(cursor / tw), cursorCol: 2 + (cursor % tw) };
}

export interface Command {
  name: string;
  args?: string;
  help: string;
}

export const COMMANDS: Command[] = [
  { name: "help", help: "Show commands and how delegation works" },
  { name: "status", help: "What every task and agent is doing" },
  { name: "review", args: "[task]", help: "Results waiting for review: claims, diff, checks, flags, votes" },
  { name: "approve", args: "[task] [notes]", help: "Approve a result (merges its branch)" },
  { name: "changes", args: "[task] <notes>", help: "Send a result back with what to fix" },
  { name: "continue", args: "<task>", help: "Hand an unfinished task to the worker again" },
  { name: "worker", args: "[agent|auto]", help: "Which agents can take work, and who's picked next (and why)" },
  { name: "lead", args: "<agent|none>", help: "One agent reviews every other agent's work" },
  { name: "council", args: "<agent>... [quorum]", help: "Agents vote on every result; a quorum decides" },
  { name: "checks", args: "<command>...", help: "Commands AgentBrain runs itself on every result" },
  { name: "message", args: "<agent|all> <text>", help: "Talk to the agents working right now" },
  { name: "dashboard", help: "Open the control room in your browser" },
  { name: "clear", help: "Clear the screen" },
  { name: "exit", help: "Leave the console (agents keep working)" },
];

/** Commands matching what's typed so far ("/re" → review), while no argument is typed. */
export function suggestions(buffer: string): Command[] {
  if (!buffer.startsWith("/") || buffer.includes(" ")) return [];
  const typed = buffer.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(typed));
}

const GLYPH: Partial<Record<ActivityEvent["kind"], string>> = {
  edit: "+",
  command: "$",
  commit: "·",
  progress: "✓",
  decision: "·",
  prompt: ">",
  tool: "·",
  session: "·",
};

/**
 * Turns feed events into transcript lines, grouping consecutive events by the
 * same agent on the same task under one header, like an agent CLI shows tool calls.
 */
export class FeedFormatter {
  private last = "";

  constructor(private readonly objective: (taskId: string | undefined) => string | undefined) {}

  format(event: ActivityEvent): string[] {
    // Reads and searches are noise in a transcript; the control room keeps them.
    if (event.kind === "tool" && /^(Read|Grep|Glob) /.test(event.text)) return [];
    const who = agentColor(event.agent)(agentLabel(event.agent));
    const goal = this.objective(event.task);
    const sub = (text: string) => `    ${text}`;

    if (event.kind === "handoff" && event.agent === "developer") {
      this.last = "";
      return ["", `${style.accent("→")} ${event.text}`, sub(style.dim(`${event.task ?? ""} · its own worktree · progress streams here`))];
    }
    if (event.kind === "review" || event.kind === "status" || event.kind === "handoff") {
      this.last = "";
      if (event.agent === "agentbrain") {
        const text = event.text.startsWith("✓") ? style.green(event.text) : event.text.startsWith("✗") || event.text.startsWith("⚠") ? style.red(event.text) : event.text;
        return [sub(`${style.accent("AgentBrain")} ${text}`)];
      }
      if (event.kind === "status" && /→ review/.test(event.text)) {
        return ["", `${style.accent("Ready")} ${style.bold("for review")} · ${short(goal ?? event.text, 70)}`, sub(`finished by ${who} · /review to inspect · /approve · /changes <what to fix>`)];
      }
      if (event.kind === "handoff") return ["", `${style.accent("⇄")} ${who} handed off · ${short(goal ?? "", 60)}`, sub(style.dim(`${event.text.replace(/^.*?: /, "")} · /continue ${event.task ?? ""}`))];
      if (event.kind === "review") return ["", `${style.accent("✓")} ${who} ${event.text}`];
      return [sub(`${who} ${style.dim(event.text.replace(/: .*$/, ""))}`)];
    }

    if (event.kind === "message") {
      this.last = "";
      return ["", `${style.accent("✉")} ${who} ${event.text}`];
    }
    const key = `${event.agent}|${event.task ?? ""}`;
    const lines: string[] = [];
    if (key !== this.last) {
      this.last = key;
      lines.push("", `${who}${goal ? style.dim(` · ${short(goal, 60)}`) : ""}`);
    }
    const glyph = GLYPH[event.kind] ?? "·";
    const text = event.kind === "edit" ? style.green(event.text) : event.kind === "command" ? style.yellow(event.text.replace(/^\$ /, "")) : event.text;
    lines.push(sub(`${style.dim(glyph)} ${text}`));
    return lines;
  }
}

// ---------------------------------------------------------------- the console

export interface ConsoleOptions {
  /** How to start AgentBrain itself in the background (for dispatch and the control room). */
  self: { command: string; args: string[] };
}

export async function runConsole(root: string, options: ConsoleOptions): Promise<void> {
  const out = process.stdout;
  const write = (s: string) => out.write(s);
  const width = () => Math.max(40, out.columns || 80);

  let buffer = "";
  let cursor = 0;
  let selected = 0;
  let status = "";
  let exitArmed = 0;
  const history: string[] = [];
  let historyIndex = -1;
  let rowInBottom = 0; // which row of the bottom area the terminal cursor is on

  const objectives = new Map<string, string>();
  const objective = (taskId?: string) => {
    if (!taskId) return undefined;
    if (!objectives.has(taskId)) {
      try { objectives.set(taskId, getTask(root, taskId).objective); } catch { return undefined; }
    }
    return objectives.get(taskId);
  };
  const feed = new FeedFormatter(objective);

  const decidesText = () => {
    const p = reviewPolicy(root);
    if (p.mode === "lead") return `lead ${agentLabel(p.reviewers[0])}`;
    if (p.mode === "council") return `council of ${p.reviewers.length} (quorum ${Math.round(p.quorum * 100)}%, survives ${faultTolerance(p.reviewers.length, p.quorum)})`;
    return "you (no reviewers set: /lead or /council)";
  };

  // Which agent the next prompt goes to: "auto" (best-placed ready agent) or one the
  // developer picked with Shift+Tab. Like an agent CLI's mode, it lasts for this session.
  let choice = getProject(root).worker ?? "auto";
  let ranked = rankWorkers(root);
  let rankedAt = Date.now();
  const ready = () => {
    if (Date.now() - rankedAt > 3000) { ranked = rankWorkers(root); rankedAt = Date.now(); }
    return ranked.filter((c) => c.worker.available);
  };
  const choices = () => ["auto", ...ready().map((c) => c.worker.id)];
  const footer = () => {
    const options = ready();
    const pick = choice === "auto" ? options[0] : options.find((c) => c.worker.id === choice);
    const label = choice === "auto"
      ? `Auto ${style.dim("→")} ${pick ? pick.worker.name : "no agent ready"}${pick ? style.dim(`  (${pick.reasons.slice(0, 2).join(", ")})`) : ""}`
      : `${pick?.worker.name ?? choice}`;
    return `  ${style.accent("⏵")} ${label}  ${style.dim("· shift+tab to switch agent · @agent in a prompt")}`;
  };

  const header = () => {
    const tasks = listTasks(root);
    return welcomeBox(width() - 1, {
      root,
      worker: workerText(),
      decides: decidesText(),
      running: tasks.filter((t) => t.status === "running").length,
      review: tasks.filter((t) => t.status === "review").length,
    });
  };

  /** "auto" (picks per task) or the pinned agent. */
  const workerText = () => {
    const pinned = getProject(root).worker;
    if (pinned) return `worker ${rankWorkers(root).find((c) => c.worker.id === pinned)?.worker.name ?? pinned}`;
    const ready = rankWorkers(root).filter((c) => c.worker.available && c.worker.how !== "pull").length;
    return `auto-picks among ${ready} ready agent${ready === 1 ? "" : "s"}`;
  };

  const statusLine = () => {
    if (status) return `  ${status}`;
    const tasks = listTasks(root);
    const running = tasks.filter((t) => t.status === "running").length;
    const review = tasks.filter((t) => t.status === "review").length;
    return style.dim(`  decides: ${decidesText()} · ${running} running`) +
      (review ? ` ${style.accent(`· ${review} to review`)}` : "") + style.dim(" · ctrl-c twice to exit");
  };

  const bottom = () => {
    // One column short of the edge: a line that fills the terminal exactly leaves the
    // cursor in a pending-wrap state that throws off the next redraw.
    const w = width() - 1;
    const box = inputBox(w, buffer, cursor);
    // A blank line separates the transcript from the prompt.
    const lines = ["", ...box.lines, fit(footer(), w), fit(statusLine(), w)];
    const options = suggestions(buffer);
    if (selected >= options.length) selected = 0;
    for (const [i, c] of options.slice(0, 10).entries()) {
      const label = `/${c.name}${c.args ? ` ${c.args}` : ""}`;
      const line = `  ${label.padEnd(30)} ${c.help}`;
      lines.push(fit(i === selected ? style.accent(line) : style.dim(line), w));
    }
    return { lines, box };
  };

  const erase = () => {
    if (rowInBottom > 0) write(`${ESC}${rowInBottom}A`);
    write(`\r${ESC}J`);
    rowInBottom = 0;
  };

  const draw = () => {
    const { lines, box } = bottom();
    write(lines.join("\n"));
    const up = lines.length - 1 - (box.cursorRow + 1);
    if (up > 0) write(`${ESC}${up}A`);
    write(`\r${box.cursorCol > 0 ? `${ESC}${box.cursorCol}C` : ""}`);
    rowInBottom = box.cursorRow + 1;
  };

  const redraw = () => { erase(); draw(); };
  const print = (lines: string[]) => {
    if (!lines.length) return;
    erase();
    write(`${lines.join("\n")}\n`);
    draw();
  };

  // ------------------------------------------------------------ commands

  const pickTask = (arg: string | undefined, filter: (t: TaskState) => boolean): TaskState | undefined => {
    const tasks = listTasks(root);
    if (arg) {
      const byId = tasks.find((t) => t.id === arg || t.id.endsWith(arg));
      if (byId) return byId;
    }
    return tasks.filter(filter).sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""))[0];
  };

  const looksLikeTask = (word: string | undefined) => Boolean(word && /^(task-)?\d{6,}/.test(word));

  const help = (): string[] => [
    "",
    style.bold(" How it works"),
    "  Type a task in plain words. AgentBrain creates it, gives it its own worktree, and hands it",
    "  to your worker. You see the agent's edits, commands and progress here as they happen.",
    "  When it finishes, the result waits for review (AgentBrain runs your /checks itself first):",
    "  approve to merge it, or send it back with what to fix.",
    "",
    style.bold(" Commands"),
    ...COMMANDS.map((c) => `  ${style.accent(`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(30))} ${c.help}`),
    "",
  ];

  const statusReport = (): string[] => {
    const tasks = listTasks(root).filter((t) => t.status !== "done");
    const sessions = listSessions(root).filter((s) => !s.endedAt);
    const lines = ["", style.bold(" Tasks")];
    if (!tasks.length) lines.push(style.dim("  Nothing in progress."));
    const color: Record<string, (t: string) => string> = { running: style.green, review: style.purple, handoff: style.blue, blocked: style.red, failed: style.red };
    for (const t of tasks) {
      lines.push(`  ${(color[t.status] ?? style.yellow)(t.status.padEnd(10))} ${short(t.objective, 70)}`);
      lines.push(style.dim(`             ${t.id}${t.agent ? ` · ${agentLabel(t.agent.id)}` : ""}${t.nextAction ? ` · next: ${short(t.nextAction, 60)}` : ""}`));
    }
    lines.push("", style.bold(" Agents"));
    const recent = sessions.filter((s) => s.lastSeenAt || s.mode === "headless").slice(-6);
    if (!recent.length) lines.push(style.dim("  No agent sessions reporting right now."));
    for (const s of recent) lines.push(`  ${agentColor(s.agentId)(agentLabel(s.agentId).padEnd(18))} ${s.activity ?? (s.mode ?? "")} ${style.dim(s.lastAction ? short(s.lastAction, 60) : "")}`);
    lines.push("", ` ${style.dim("Decides")} ${decidesText()}`, "");
    return lines;
  };

  const reviewReport = (arg?: string): string[] => {
    const tasks = arg ? [pickTask(arg, () => true)].filter(Boolean) as TaskState[] : pendingReviews(root);
    if (!tasks.length) return ["", style.dim("  Nothing is waiting for review."), ""];
    const lines: string[] = [];
    for (const task of tasks) {
      lines.push("");
      for (const line of reviewSummary(root, task).split("\n")) {
        lines.push(line.startsWith("###") ? style.bold(` ${line.replace(/^### /, "")}`) : line.startsWith("- FAIL") || /flag/i.test(line) ? style.red(`  ${line}`) : line.startsWith("- PASS") ? style.green(`  ${line}`) : `  ${line}`);
      }
      const t = computeTally(root, task);
      if (t.total > 0) lines.push(style.dim(`  Votes: ${t.approve.toFixed(1)} approve / ${t.changes.toFixed(1)} changes of ${t.total.toFixed(1)}${t.blocked ? ` · ${t.blocked}` : ""}`));
    }
    lines.push("", style.dim("  /approve [task]   or   /changes [task] <what to fix>"), "");
    return lines;
  };

  const run = async (line: string): Promise<string[]> => {
    const [rawName, ...words] = line.slice(1).trim().split(/\s+/);
    const name = rawName?.toLowerCase();
    const rest = words.join(" ");
    switch (name) {
      case "help":
        return help();
      case "status":
        return statusReport();
      case "review":
        return reviewReport(words[0]);
      case "approve":
      case "changes": {
        const id = looksLikeTask(words[0]) ? words[0] : undefined;
        const notes = (id ? words.slice(1) : words).join(" ");
        const task = pickTask(id, (t) => t.status === "review");
        if (!task || task.status !== "review") return [style.yellow("  Nothing is waiting for review.")];
        if (name === "changes" && !notes) return [style.yellow("  Say what needs to change: /changes <what to fix>")];
        const result = reviewTask(root, task.id, { verdict: name === "approve" ? "approved" : "changes", reviewer: "developer", notes: notes || undefined });
        if (result.conflicts) return [style.red(`  ${task.id} conflicts with your branch in ${result.conflicts.join(", ")}; merge aborted, still in review.`)];
        if (name === "approve") return [style.green(`  ✓ Approved${result.merged ? ` and merged ${result.merged} commit(s)` : ""}: ${task.objective}`)];
        return [style.green(`  ✓ Sent back with your notes. /continue ${task.id} hands it to an agent now.`)];
      }
      case "continue": {
        const task = pickTask(words[0], (t) => t.status === "handoff" || t.status === "idle" || t.status === "blocked");
        if (!task) return [style.yellow("  No unfinished task to continue.")];
        const result = delegate(root, { taskId: task.id }, options.self);
        return [style.dim(`  Handing ${task.id} to ${result.worker.name}…`)];
      }
      case "worker": {
        if (!words[0]) {
          const pinned = getProject(root).worker;
          const ranked = rankWorkers(root);
          const lines = ["", `  ${pinned ? `Pinned: ${style.bold(ranked.find((c) => c.worker.id === pinned)?.worker.name ?? pinned)}` : `${style.bold("Auto")}: each task goes to the best-placed ready agent`}`, ""];
          for (const [i, c] of ranked.entries()) {
            const mark = !c.worker.available ? style.dim("○") : i === 0 || c.worker.id === pinned ? style.green("●") : "○";
            const how = { chat: "your open VS Code chat", print: "background, no window", headless: "background (ACP)", pull: "picked up over MCP" }[c.worker.how];
            lines.push(`  ${mark} ${(c.worker.available ? (s: string) => s : style.dim)(`${c.worker.name.padEnd(22)} ${how.padEnd(22)}`)} ${style.dim(c.reasons.join(", "))}`);
          }
          lines.push("", style.dim("  /worker <agent> pins one · /worker auto picks per task · start a prompt with @claude, @codex, @copilot or @any"), "");
          return lines;
        }
        return [style.green(`  ✓ New prompts go to ${setDefaultWorker(root, words[0])}.`)];
      }
      case "lead":
        if (!words[0]) return [`  ${decidesText()}`];
        setLead(root, words[0] === "none" ? null : words[0]);
        return [style.green(`  ✓ Decides: ${decidesText()}`)];
      case "council": {
        if (!words.length) return [`  ${decidesText()}`, ...Object.entries(readReputation(root)).map(([id, r]) => style.dim(`  ${agentLabel(id).padEnd(18)} weight ${r.score.toFixed(2)} · agreed ${r.agreed} · dissented ${r.dissented} · flagged ${r.flagged}`))];
        if (words[0] === "none") { setCouncil(root, null); return [style.green("  ✓ Council dissolved.")]; }
        const quorum = words.find((x) => /^0?\.\d+$|^1$/.test(x));
        setCouncil(root, words.filter((x) => x !== quorum), quorum ? Number(quorum) : undefined);
        return [style.green(`  ✓ Decides: ${decidesText()}`)];
      }
      case "checks":
        if (!rest) return [`  ${(getProject(root).checks ?? []).join(" · ") || style.dim("No checks. Example: /checks npm test")}`];
        setChecks(root, rest === "none" ? [] : rest.split(/\s*;\s*|\s*,\s*/).filter(Boolean));
        return [style.green(`  ✓ AgentBrain runs on every result: ${(getProject(root).checks ?? []).join(" · ") || "nothing"}`)];
      case "message": {
        if (!words[0] || words.length < 2) return [style.yellow("  /message <agent|all> <text>   e.g. /message vscode hold off on page.ts, I'm editing it")];
        const to = ({ claude: "claude-code", copilot: "vscode" } as Record<string, string>)[words[0].toLowerCase()] ?? words[0];
        const message = sendMessage(root, { from: "developer", to, text: words.slice(1).join(" ") });
        const pushed = deliverToChat(root, message);
        return [style.dim(`    sent${pushed ? " (and put in the VS Code chat)" : ""}`)];
      }
      case "dashboard": {
        const ui = await startUiDaemon(root, options.self.command, options.self.args);
        openBrowser(ui.url);
        return [style.green(`  ✓ Control room: ${ui.url}`)];
      }
      case "clear":
        write(`${ESC}2J${ESC}H`);
        rowInBottom = 0;
        return [];
      case "exit":
      case "quit":
        quit();
        return [];
      default:
        return [style.yellow(`  Unknown command /${rawName}. /help lists them.`)];
    }
  };

  const submit = async () => {
    const line = buffer.trim();
    buffer = "";
    cursor = 0;
    selected = 0;
    if (!line) return redraw();
    history.unshift(line);
    historyIndex = -1;
    print(["", `${style.dim(">")} ${line}`]);
    try {
      if (line.startsWith("/")) print(await run(line));
      else {
        const result = delegate(root, { prompt: line, ...(choice === "auto" ? {} : { worker: choice }) }, options.self);
        objectives.set(result.task.id, result.task.objective);
        if (result.worker.how === "pull") print([`    ${style.dim("Open any agent on this repo (Claude app, Cursor, VS Code) and say \"continue\"; it picks this up.")}`]);
      }
    } catch (error) {
      print([style.red(`  ${error instanceof Error ? error.message : String(error)}`)]);
    }
  };

  // ------------------------------------------------------------ live feed

  let offset = fs.existsSync(activityFile(root)) ? fs.statSync(activityFile(root)).size : 0;
  let partial = "";
  const poll = () => {
    try {
      const file = activityFile(root);
      if (!fs.existsSync(file)) return;
      const size = fs.statSync(file).size;
      if (size < offset) offset = 0; // the file was trimmed
      if (size === offset) return;
      const fd = fs.openSync(file, "r");
      const chunk = Buffer.alloc(size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      fs.closeSync(fd);
      offset = size;
      const text = partial + chunk.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      const rendered: string[] = [];
      for (const line of lines.filter(Boolean)) {
        try { rendered.push(...feed.format(JSON.parse(line) as ActivityEvent)); } catch { /* skip a bad line */ }
      }
      print(rendered);
    } catch {
      // the feed is best-effort
    }
  };
  const feedTimer = setInterval(poll, 400);

  // ------------------------------------------------------------ input

  function quit(): void {
    clearInterval(feedTimer);
    erase();
    write(style.dim("Agents keep working in the background. `agentbrain` brings you back.\n"));
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  }

  const insert = (text: string) => {
    const chars = [...buffer];
    chars.splice(cursor, 0, ...text);
    buffer = chars.join("");
    cursor += [...text].length;
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", (str: string | undefined, key: readline.Key) => {
    const options = suggestions(buffer);
    if (key?.ctrl && key.name === "c") {
      if (buffer) { buffer = ""; cursor = 0; return redraw(); }
      if (Date.now() - exitArmed < 2000) return quit();
      exitArmed = Date.now();
      status = style.yellow("Press Ctrl-C again to exit");
      setTimeout(() => { status = ""; redraw(); }, 2000);
      return redraw();
    }
    if (key?.ctrl && key.name === "d" && !buffer) return quit();
    if (key?.name === "return") {
      // Enter on a half-typed command picks the highlighted suggestion first.
      if (options.length && options[selected] && buffer !== `/${options[selected].name}`) {
        buffer = `/${options[selected].name}${options[selected].args ? " " : ""}`;
        cursor = [...buffer].length;
        if (options[selected].args) return redraw();
      }
      void submit();
      return;
    }
    if (key?.name === "tab" && key.shift) {
      const list = choices();
      choice = list[(list.indexOf(choice) + 1) % list.length] ?? "auto";
      return redraw();
    }
    if (key?.name === "tab" && options.length) {
      buffer = `/${options[selected].name} `;
      cursor = [...buffer].length;
      return redraw();
    }
    if (key?.name === "up") {
      if (options.length) selected = (selected - 1 + options.length) % options.length;
      else if (history.length) { historyIndex = Math.min(historyIndex + 1, history.length - 1); buffer = history[historyIndex]; cursor = [...buffer].length; }
      return redraw();
    }
    if (key?.name === "down") {
      if (options.length) selected = (selected + 1) % options.length;
      else if (historyIndex > 0) { historyIndex--; buffer = history[historyIndex]; cursor = [...buffer].length; }
      else { historyIndex = -1; buffer = ""; cursor = 0; }
      return redraw();
    }
    if (key?.name === "left") { cursor = Math.max(0, cursor - 1); return redraw(); }
    if (key?.name === "right") { cursor = Math.min([...buffer].length, cursor + 1); return redraw(); }
    if ((key?.ctrl && key.name === "a") || key?.name === "home") { cursor = 0; return redraw(); }
    if ((key?.ctrl && key.name === "e") || key?.name === "end") { cursor = [...buffer].length; return redraw(); }
    if (key?.ctrl && key.name === "u") { buffer = ""; cursor = 0; return redraw(); }
    if (key?.name === "escape") { if (options.length) { buffer = ""; cursor = 0; } return redraw(); }
    if (key?.name === "backspace") {
      if (cursor > 0) { const chars = [...buffer]; chars.splice(cursor - 1, 1); buffer = chars.join(""); cursor--; }
      return redraw();
    }
    if (key?.name === "delete") {
      const chars = [...buffer]; chars.splice(cursor, 1); buffer = chars.join("");
      return redraw();
    }
    if (str && !key?.ctrl && !key?.meta && str >= " ") {
      insert(str.replace(/[\r\n]+/g, " "));
      selected = 0;
      return redraw();
    }
  });
  // Lines already on screen re-wrap when the terminal is resized, so the bottom area can't
  // be erased line by line any more: redraw the screen (the transcript stays in scrollback).
  let resizeTimer: NodeJS.Timeout | null = null;
  out.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      write(`${ESC}H${ESC}2J`);
      rowInBottom = 0;
      write(`${header().join("\n")}\n`);
      draw();
    }, 80);
  });

  // ------------------------------------------------------------ start

  const tasks = listTasks(root);
  write(`${header().join("\n")}\n`);
  const waiting = pendingReviews(root);
  if (waiting.length) {
    write(`${style.accent("Review")} ${style.bold(`${waiting.length} result(s) waiting for your review`)}\n`);
    for (const t of waiting.slice(0, 5)) write(`  ${style.dim("·")}  ${short(t.objective, 70)} ${style.dim(`· by ${agentLabel(t.review?.worker ?? t.agent?.id ?? "?")} · ${t.id}`)}\n`);
    write(`  ${style.dim("/review to inspect · /approve · /changes <what to fix>")}\n\n`);
  }
  draw();
}
