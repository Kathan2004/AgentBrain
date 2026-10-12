/**
 * `agentbrain` with no arguments: the AgentBrain console. In a TTY it is a
 * full-screen split-pane room (sidebar + main pane + compose box) matching the
 * web control room; without a TTY the CLI usage text is printed instead.
 *
 * Rendering helpers are pure (exported for tests); runConsole does the I/O.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { activityFile, readActivity, type ActivityEvent } from "../core/activity.js";
import { connectConnector, detectConnectors, disconnectConnector, type Capability, type Connector, type ConnectorKind } from "../core/connectors.js";
import { claudeBinary, codexBinary, delegate, deliverToChat, planGoal, rankWorkers, setDefaultWorker } from "../core/delegate.js";
import { requestStop, sendToSession, sessionControl } from "../core/headless.js";
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
import { getProject, getTask, listSessions, listTasks, sessionAlive } from "../core/store.js";
import { snapshot, sessionPresent } from "./model.js";
import { openInEditor } from "./open.js";
import { taskWorkdir } from "../core/worktree.js";
import { printAgent, runChat } from "../core/printrun.js";
import { chatBrief } from "../core/context.js";
import { openBrowser, startUiDaemon } from "./daemon.js";
import {
  age,
  agentPaint,
  colorMode,
  ellipsize,
  fit,
  hexPaint,
  hhmm,
  NARROW,
  PANES,
  shortTitle,
  sidebarLines,
  sidebarOrder,
  stateDot,
  stateTone,
  ui,
  visibleLength,
  type Pane,
} from "./tui.js";

// ---------------------------------------------------------------- styling

const ESC = "\x1b[";
/** The control room's graphite palette; colour follows COLORTERM and NO_COLOR when painted. */
export const style = {
  text: ui.text,
  muted: ui.muted,
  dim: ui.faint,
  line: ui.line,
  bold: ui.bold,
  accent: (t: string) => ui.bold(ui.text(t)),
  green: ui.ok,
  red: ui.failed,
  yellow: ui.review,
  orange: ui.waiting,
  teal: ui.running,
  purple: ui.done,
};
export function agentLabel(id: string): string {
  const names: Record<string, string> = {
    "claude-code": "Claude Code",
    vscode: "Copilot (VS Code)",
    codex: "Codex",
    gemini: "Gemini",
    cursor: "Cursor",
    copilot: "Copilot CLI",
    aider: "Aider",
    ollama: "Local model",
    developer: "You",
    agentbrain: "AgentBrain",
    council: "Council",
  };
  return names[id] ?? id;
}

/** An agent's coloured dot and name, as the web's live rail and chat replies show them. */
export function agentTag(id: string, label = agentLabel(id)): string {
  return `${agentPaint(id)("●")} ${style.accent(label)}`;
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Word-wraps plain text; words longer than the width are split. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      let rest = [...word];
      if (line && [...line].length + 1 + rest.length > w) {
        lines.push(line);
        line = "";
      }
      if (line) line += " ";
      while ([...line].length + rest.length > w) {
        const take = w - [...line].length;
        lines.push(line + rest.slice(0, take).join(""));
        line = "";
        rest = rest.slice(take);
      }
      line += rest.join("");
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------- pure rendering

export interface WelcomeTask {
  id: string;
  objective: string;
  status: string;
  updatedAt?: string;
  nextAction?: string;
  merged?: unknown;
}

export interface TeamMember {
  id: string;
  name: string;
  /** Installed and ready. */
  up: boolean;
  lead?: boolean;
}

export interface WelcomeInfo {
  root: string;
  tasks: WelcomeTask[];
  /** Agent sessions that haven't ended. */
  agentsActive: number;
  /** Who decides, as the web says it: "Lead: Claude Code", "Council of 3 …", "You decide". */
  decides: string;
  checks: string[];
  team: TeamMember[];
  now?: Date;
}

const IN_PROGRESS = ["running", "checkpoint", "handoff", "idle", "blocked", "failed"];

/** One task row: status dot, short title, age right-aligned; exactly `width` wide. */
export function taskRow(task: WelcomeTask, width: number, now = new Date()): string {
  const when = age(task.updatedAt, now);
  const title = ellipsize(shortTitle(task.objective), Math.max(1, width - 4 - when.length - 1));
  const gap = Math.max(1, width - 4 - visibleLength(title) - when.length);
  return `  ${stateDot(task)} ${style.text(title)}${" ".repeat(gap)}${style.dim(when)}`;
}

/** The welcome screen, laid out like the web's Tasks home; never wider than `width`. */
export function welcomeBox(width: number, info: WelcomeInfo): string[] {
  const w = Math.max(40, Math.min(width, 100));
  const now = info.now ?? new Date();
  const row = (text: string) => ellipsize(text, w);
  const project = path.basename(info.root) || info.root;
  const review = info.tasks.filter((t) => t.status === "review");
  const active = info.tasks.filter((t) => IN_PROGRESS.includes(t.status));
  const recent = info.tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 3);
  const running = info.tasks.filter((t) => t.status === "running").length;
  const n = (count: number, text: string) => `${style.accent(String(count))} ${style.muted(text)}`;
  const facts = [
    n(review.length, "to review"),
    n(running, "running"),
    n(info.agentsActive, `agent${info.agentsActive === 1 ? "" : "s"} active`),
    style.muted(info.decides),
    ...(info.checks.length ? [`${style.muted("Checks:")} ${style.text(info.checks.join(" · "))}`] : []),
  ];

  const lines = [row(` ${style.accent("AgentBrain")}  ${style.muted(project)}`), row(` ${facts.join(style.dim(" · "))}`), ""];
  const section = (title: string, tasks: WelcomeTask[], empty: string, max: number, count = true) => {
    lines.push(row(` ${style.accent(title)}${count && tasks.length ? ` ${style.dim(String(tasks.length))}` : ""}`));
    if (!tasks.length) lines.push(row(`  ${style.dim(empty)}`));
    for (const task of tasks.slice(0, max)) lines.push(taskRow(task, w, now));
    if (tasks.length > max) lines.push(row(`    ${style.dim(`+${tasks.length - max} more · /status`)}`));
  };
  section("Needs you", review, "Nothing to review.", 5);
  section("In progress", active, "Nothing running.", 5);
  section("Recent", recent, "No finished tasks yet.", 3, false);
  if (info.team.length) {
    const members = info.team.map((m) => `${m.up ? style.green("●") : style.dim("○")} ${m.up ? style.text(m.name) : style.dim(m.name)}${m.lead ? ` ${style.yellow("LEAD")}` : ""}`);
    lines.push("", row(` ${style.accent("Team")}  ${members.join("  ")}`));
  }
  lines.push("");
  return lines;
}

export interface InputRender {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

export interface InputPills {
  /** What the agent pill says, e.g. "Auto → Claude Code". */
  agent: string;
  /** Colours the agent pill. */
  agentId?: string;
  mode: "chat" | "task";
}

const PLACEHOLDER = "Describe a task for your agents, or type / for commands";
const CHAT_PLACEHOLDER = "Ask anything about this project, or type / for commands";
const INPUT_HINT = "shift+tab agent · /mode · / for commands";

/** The row under the prompt box: agent and mode pills, and a hint on the right when it fits. */
export function pillRow(width: number, pills: InputPills): string {
  const pill = (inner: string) => `${style.dim("[")} ${inner} ${style.dim("]")}`;
  const agent = pills.agentId ? agentPaint(pills.agentId)(pills.agent) : style.text(pills.agent);
  const where = pills.mode === "chat" ? "Chat · project root" : "Task · own worktree";
  const left = ` ${pill(agent)} ${pill(style.muted(where))}`;
  const gap = width - visibleLength(left) - INPUT_HINT.length - 1;
  return gap >= 2 ? `${left}${" ".repeat(gap)}${style.dim(INPUT_HINT)} ` : ellipsize(left, width);
}

/** A rounded prompt box at exactly `width` columns; long input wraps inside it. */
export function inputBox(width: number, buffer: string, cursor: number, pills?: InputPills): InputRender {
  const w = Math.max(20, width);
  const tw = w - 4;
  const chars = [...buffer];
  const rows = Math.max(1, Math.floor(chars.length / tw) + 1);
  const placeholder = pills?.mode === "chat" ? CHAT_PLACEHOLDER : PLACEHOLDER;
  const lines: string[] = [style.line(`╭${"─".repeat(w - 2)}╮`)];
  for (let r = 0; r < rows; r++) {
    const text = chars.slice(r * tw, (r + 1) * tw).join("");
    const body = !buffer && r === 0 ? style.dim(ellipsize(placeholder, tw)) : text;
    lines.push(`${style.line("│")} ${fit(body, tw)} ${style.line("│")}`);
  }
  lines.push(style.line(`╰${"─".repeat(w - 2)}╯`));
  if (pills) lines.push(pillRow(w, pills));
  return { lines, cursorRow: 1 + Math.floor(cursor / tw), cursorCol: 2 + (cursor % tw) };
}

export interface Command {
  name: string;
  args?: string;
  help: string;
}

export const COMMANDS: Command[] = [
  { name: "help", help: "Show commands and how delegation works" },
  { name: "status", help: "What every task and agent is doing" },
  { name: "now", help: "Plain-language next actions for active and review tasks" },
  { name: "live", args: "[task]", help: "Show a headless agent's live transcript and attach command" },
  { name: "mode", args: "[chat|task]", help: "Chat with the selected model or create sandboxed tasks" },
  { name: "task", args: "<request>", help: "Explicitly delegate a request into its own worktree" },
  { name: "review", args: "[task]", help: "Results waiting for review: claims, diff, checks, flags, votes" },
  { name: "approve", args: "[task] [notes]", help: "Approve a result (merges its branch)" },
  { name: "changes", args: "[task] <notes>", help: "Send a result back with what to fix" },
  { name: "plan", args: "<goal>", help: "A planner agent splits a big goal and delegates the pieces in parallel" },
  { name: "continue", args: "<task>", help: "Hand an unfinished task to the worker again" },
  { name: "worker", args: "[agent|auto]", help: "Which agents can take work, and who's picked next (and why)" },
  { name: "lead", args: "<agent|none>", help: "One agent reviews every other agent's work" },
  { name: "council", args: "<agent>... [quorum]", help: "Agents vote on every result; a quorum decides" },
  { name: "checks", args: "<command>...", help: "Commands AgentBrain runs itself on every result" },
  { name: "connectors", help: "Installed tools and whether AgentBrain is connected" },
  { name: "connect", args: "<id>", help: "Connect a tool by writing AgentBrain into its MCP config" },
  { name: "disconnect", args: "<id>", help: "Remove AgentBrain from a tool's MCP config" },
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

/** The developer's message, right-aligned in a dim rounded bubble; every line is `width` wide. */
export function userBubble(text: string, width: number): string[] {
  const w = Math.max(20, width);
  const body = wrapText(text.trim(), Math.max(8, Math.floor(w * 0.75) - 4));
  const inner = Math.max(...body.map((l) => [...l].length));
  const pad = " ".repeat(w - inner - 4);
  return [
    `${pad}${style.dim(`╭${"─".repeat(inner + 2)}╮`)}`,
    ...body.map((l) => `${pad}${style.dim("│")} ${style.text(l)}${" ".repeat(inner - [...l].length)} ${style.dim("│")}`),
    `${pad}${style.dim(`╰${"─".repeat(inner + 2)}╯`)}`,
  ];
}

type Paint = (t: string) => string;

/** **bold** and `code` spans of one line, as runs of characters with their style. */
function inlineChars(text: string): { ch: string; paint: Paint }[] {
  const plain = colorMode() === "none";
  const out: { ch: string; paint: Paint }[] = [];
  const add = (s: string, paint: Paint) => { for (const ch of s) out.push({ ch, paint }); };
  for (const part of text.split(/(`[^`]+`)/)) {
    if (/^`[^`]+`$/.test(part)) add(plain ? part : part.slice(1, -1), style.muted);
    else for (const p of part.split(/(\*\*[^*]+\*\*)/)) add(/^\*\*[^*]+\*\*$/.test(p) ? p.slice(2, -2) : p, /^\*\*[^*]+\*\*$/.test(p) ? style.accent : style.text);
  }
  return out;
}

function paintRuns(chars: { ch: string; paint: Paint }[]): string {
  let out = "";
  for (let i = 0; i < chars.length; ) {
    let j = i;
    while (j < chars.length && chars[j].paint === chars[i].paint) j++;
    out += chars[i].paint(chars.slice(i, j).map((c) => c.ch).join(""));
    i = j;
  }
  return out;
}

/** Word-wraps styled inline markdown; continuation lines get `hang`. */
function wrapInline(text: string, width: number, first: string, hang: string): string[] {
  const words: { ch: string; paint: Paint }[][] = [[]];
  for (const c of inlineChars(text)) {
    if (c.ch === " ") words.push([]);
    else words[words.length - 1].push(c);
  }
  const lines: string[] = [];
  let line: { ch: string; paint: Paint }[] = [];
  const room = () => Math.max(1, width - visibleLength(lines.length ? hang : first));
  const flush = () => { lines.push(`${lines.length ? hang : first}${paintRuns(line)}`); line = []; };
  for (let word of words.filter((x) => x.length)) {
    if (line.length && line.length + 1 + word.length > room()) flush();
    if (line.length) line.push({ ch: " ", paint: style.text });
    while (line.length + word.length > room()) {
      const take = room() - line.length;
      line.push(...word.slice(0, take));
      word = word.slice(take);
      flush();
    }
    line.push(...word);
  }
  if (line.length || !lines.length) flush();
  return lines;
}

/**
 * Light markdown for agent replies, fed one line at a time (replies stream in):
 * **bold**, `code` spans dim, fenced code blocks inside a faint box, "- " bullets as "•".
 */
export class MarkdownStream {
  private fence: string | null = null;

  constructor(private readonly width: number, private readonly indent = "  ") {}

  get inFence(): boolean {
    return this.fence !== null;
  }

  push(line: string): string[] {
    const w = Math.max(20, this.width) - this.indent.length;
    const fence = /^\s*```\s*([^\s`]*)/.exec(line);
    if (fence) {
      if (this.fence === null) {
        this.fence = fence[1];
        const label = this.fence ? `─ ${this.fence} ` : "";
        return [`${this.indent}${style.dim(`╭${ellipsize(label, w - 2)}${"─".repeat(Math.max(0, w - 2 - label.length))}╮`)}`];
      }
      return this.end();
    }
    if (this.fence !== null) {
      return wrapText(line.replace(/\t/g, "  ").replace(/\s+$/, ""), w - 4).map((part) => `${this.indent}${style.dim("│")} ${style.text(part)}${" ".repeat(Math.max(0, w - 4 - [...part].length))} ${style.dim("│")}`);
    }
    if (!line.trim()) return [""];
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return wrapInline(`**${heading[1].replace(/\*\*/g, "")}**`, w, this.indent, this.indent);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const lead = `${this.indent}${bullet[1]}`;
      return wrapInline(bullet[2], w + this.indent.length, `${lead}${style.dim("•")} `, `${lead}  `);
    }
    const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    if (numbered) {
      const lead = `${this.indent}${numbered[1]}`;
      return wrapInline(numbered[3], w + this.indent.length, `${lead}${style.dim(numbered[2])} `, `${lead}${" ".repeat(numbered[2].length + 1)}`);
    }
    return wrapInline(line.trim(), w + this.indent.length, this.indent, this.indent);
  }

  /** Closes a code block the reply left open. */
  end(): string[] {
    if (this.fence === null) return [];
    this.fence = null;
    const w = Math.max(20, this.width) - this.indent.length;
    return [`${this.indent}${style.dim(`╰${"─".repeat(w - 2)}╯`)}`];
  }
}

/** Renders a whole markdown reply. */
export function markdownLines(text: string, width: number, indent = "  "): string[] {
  const md = new MarkdownStream(width, indent);
  return [...text.split("\n").flatMap((line) => md.push(line)), ...md.end()];
}

export interface CardInfo {
  /** Who is on it, shown on the meta line. */
  agent?: string;
  /** What to do next, shown in bold. */
  action?: string;
  now?: Date;
}

/** A compact task card: status dot, short title, state label coloured by state, meta, next action. */
export function taskCard(task: WelcomeTask, width: number, info: CardInfo = {}): string[] {
  const w = Math.max(40, Math.min(width, 100));
  const tone = stateTone(task);
  const title = ellipsize(shortTitle(task.objective), w - 4 - tone.label.length - 1);
  const gap = Math.max(1, w - 3 - visibleLength(title) - tone.label.length);
  const when = age(task.updatedAt, info.now);
  const meta = [task.id, info.agent, when && `${when}${when === "now" ? "" : " ago"}`].filter(Boolean).join(" · ");
  const lines = [` ${stateDot(task)} ${style.accent(title)}${" ".repeat(gap)}${hexPaint(tone.hex)(tone.label)}`, ellipsize(`   ${style.dim(meta)}`, w)];
  if (info.action) lines.push(ellipsize(`   ${style.text(info.action)}`, w));
  return lines;
}

/** One line of the live feed, like the web's rail: dot, agent, HH:MM, event, and the task when it fits. */
export function railLine(agent: string, at: string, text: string, title: string | undefined, width: number): string {
  const base = `${agentPaint(agent)("●")} ${style.accent(agentLabel(agent))} ${style.dim(hhmm(at))}  ${text}`;
  const tail = title ? style.dim(` · ${title}`) : "";
  if (tail && visibleLength(base) + visibleLength(tail) <= width) return `${base}${tail}`;
  return ellipsize(base, width);
}

const GLYPH: Partial<Record<ActivityEvent["kind"], string>> = {
  edit: "+",
  command: "$",
  commit: "◆",
  progress: "✓",
  decision: "·",
  prompt: ">",
  tool: "·",
  session: "·",
};

/**
 * Turns feed events into transcript lines like the web's live rail: one line per
 * event, a blank line whenever the agent or task changes.
 */
export class FeedFormatter {
  private last = "";

  constructor(
    private readonly objective: (taskId: string | undefined) => string | undefined,
    private readonly width: () => number = () => 100,
  ) {}

  format(event: ActivityEvent): string[] {
    // Reads and searches are noise in a transcript; the control room keeps them.
    if (event.kind === "tool" && /^(Read|Grep|Glob) /.test(event.text)) return [];
    const w = Math.max(40, this.width());
    const goal = this.objective(event.task);
    const title = goal ? shortTitle(goal) : undefined;
    const rail = (text: string, withTitle = true) => railLine(event.agent, event.at, text, withTitle ? title : undefined, w);
    const sub = (text: string) => ellipsize(`    ${style.dim(text)}`, w);
    const key = `${event.agent}|${event.task ?? ""}`;
    const gap = key !== this.last ? [""] : [];
    this.last = key;

    if (event.kind === "handoff" && event.agent === "developer") {
      this.last = "";
      return ["", rail(`${style.muted("→")} ${style.text(event.text)}`, false), sub(`${event.task ?? ""} · its own worktree · progress streams here`)];
    }
    if (event.kind === "review" || event.kind === "status" || event.kind === "handoff") {
      if (event.agent === "agentbrain") {
        const text = event.text.startsWith("✓") ? style.green(event.text) : event.text.startsWith("✗") || event.text.startsWith("⚠") ? style.red(event.text) : style.text(event.text);
        return [...gap, rail(text)];
      }
      if (event.kind === "status" && /→ review/.test(event.text)) {
        this.last = "";
        return ["", rail(style.yellow("Ready for review")), sub(`finished by ${agentLabel(event.agent)} · /review to inspect · /approve · /changes <what to fix>`)];
      }
      if (event.kind === "handoff") {
        this.last = "";
        return ["", rail(style.orange("handed off")), sub(`${event.text.replace(/^.*?: /, "")} · /continue ${event.task ?? ""}`)];
      }
      if (event.kind === "review") return [...gap, rail(`${style.green("✓")} ${style.text(event.text)}`)];
      return [...gap, rail(style.dim(event.text.replace(/: .*$/, "")))];
    }
    if (event.kind === "message") {
      this.last = "";
      return ["", rail(`${style.muted("✉")} ${style.text(event.text)}`, false)];
    }
    const glyph = GLYPH[event.kind] ?? "·";
    const mark = event.kind === "edit" ? style.green(glyph) : event.kind === "command" ? style.yellow(glyph) : style.dim(glyph);
    const text = event.kind === "command" ? event.text.replace(/^\$ /, "") : event.text;
    return [...gap, rail(`${mark} ${style.text(text)}`)];
  }
}

/** A compact task pane: the card, a short files list, and remaining steps. */
export function taskDetailLines(
  task: WelcomeTask & { files?: string[]; remaining?: string[] },
  width: number,
  info: CardInfo = {},
): string[] {
  const w = Math.max(20, width);
  const lines = [...taskCard(task, w, info).map((l) => fit(l, w))];
  if (task.files?.length) {
    lines.push(fit("", w), fit(ellipsize(` ${style.muted("Files changed")} ${style.dim(String(task.files.length))}`, w), w));
    for (const file of task.files.slice(0, 8)) lines.push(fit(ellipsize(`  ${style.text(file)}`, w), w));
  }
  if (task.remaining?.length) {
    lines.push(fit("", w), fit(` ${style.muted("Next")}`, w));
    task.remaining.slice(0, 6).forEach((step, i) => lines.push(fit(ellipsize(`  ${style.dim(`${i + 1}.`)} ${style.text(step)}`, w), w)));
  }
  return lines;
}

/**
 * Activity as a transcript: each thought/prompt heads the commands and edits
 * it led to, folded as "Ran N commands" like the web story.
 */
export function storyLines(events: ActivityEvent[], width: number, titleOf?: (taskId: string | undefined) => string | undefined): string[] {
  const w = Math.max(20, width);
  const lines: string[] = [];
  for (let i = 0; i < events.length; ) {
    const event = events[i];
    if (event.kind === "session") {
      i++;
      continue;
    }
    if (event.kind === "thought" || event.kind === "prompt") {
      const head = event.kind === "prompt" ? style.text(event.text) : style.muted(event.text);
      lines.push(fit(railLine(event.agent, event.at, head, titleOf?.(event.task), w), w));
      i++;
      let commands = 0;
      let edits = 0;
      while (i < events.length && events[i].agent === event.agent && (events[i].kind === "command" || events[i].kind === "edit" || events[i].kind === "tool")) {
        if (events[i].kind === "command") commands++;
        else if (events[i].kind === "edit") edits++;
        i++;
      }
      const parts = [
        commands ? `Ran ${commands} command${commands === 1 ? "" : "s"}` : "",
        edits ? `edited ${edits} file${edits === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      if (parts.length) lines.push(fit(ellipsize(`    ${style.dim(parts.join(", "))}`, w), w));
      continue;
    }
    const feed = new FeedFormatter(titleOf ?? (() => undefined), () => w);
    lines.push(...feed.format(event).map((l) => fit(l, w)));
    i++;
  }
  return lines;
}

export interface RoomModel {
  project: string;
  tasks: WelcomeTask[];
  team: TeamMember[];
  agentsActive: number;
  decides: string;
  checks?: string[];
  pane: Pane;
  selectedId?: string;
  /** Main-pane lines for the current view (already fitted or wrapped). */
  body: string[];
  scroll?: number;
  buffer: string;
  cursor: number;
  pills: InputPills;
  commands?: Command[];
  selectedCommand?: number;
  status?: string;
  now?: Date;
}

export interface RoomFrame {
  lines: string[];
  sidebar: ReturnType<typeof sidebarLines>;
  listWidth: number;
  composeTop: number;
  cursorRow: number;
  cursorCol: number;
}

/** The full-screen control room: header, facts, sidebar, main pane, compose box. */
export function renderRoom(model: RoomModel, width: number, height: number): RoomFrame {
  const w = Math.max(20, width);
  const h = Math.max(10, height);
  const now = model.now ?? new Date();
  const review = model.tasks.filter((t) => t.status === "review").length;
  const running = model.tasks.filter((t) => t.status === "running").length;
  const n = (count: number, text: string) => `${style.accent(String(count))} ${style.muted(text)}`;
  const facts = [
    n(review, "to review"),
    n(running, "running"),
    n(model.agentsActive, `agent${model.agentsActive === 1 ? "" : "s"} active`),
    style.muted(model.decides),
    ...(model.checks?.length ? [`${style.muted("Checks:")} ${style.text(model.checks.join(" · "))}`] : []),
  ];
  const header = [
    fit(` ${style.accent("AgentBrain")}  ${style.muted(model.project)}`, w),
    fit(` ${facts.join(style.dim(" · "))}`, w),
  ];

  const box = inputBox(w, model.buffer, model.cursor, model.pills);
  const sugg = (model.commands ?? []).slice(0, 8);
  const suggLines = sugg.map((c, i) => {
    const label = `/${c.name}${c.args ? ` ${c.args}` : ""}`;
    const line = `  ${label.padEnd(28)} ${c.help}`;
    return fit(i === (model.selectedCommand ?? 0) ? style.accent(line) : style.dim(line), w);
  });
  const status = model.status ? [fit(ellipsize(`  ${model.status}`, w), w)] : [];
  const compose = [...box.lines, ...status, ...suggLines];
  const bodyH = Math.max(1, h - header.length - compose.length);
  const wide = w >= NARROW;
  const listWidth = wide ? Math.min(40, Math.max(22, Math.floor(w * 0.34))) : 0;
  const emptySidebar = { lines: [] as string[], rows: new Map<number, string>(), nav: new Map<number, Pane>() };
  let sidebar = emptySidebar;
  const body = model.body;
  const maxScroll = Math.max(0, body.length - bodyH);
  const scroll = Math.max(0, Math.min(model.scroll ?? maxScroll, maxScroll));
  const vis = body.slice(scroll, scroll + bodyH);

  const lines: string[] = [...header];
  if (wide) {
    sidebar = sidebarLines(
      { tasks: model.tasks, team: model.team, pane: model.pane, selectedId: model.selectedId, focused: !model.buffer, now },
      listWidth,
      bodyH,
    );
    const paneW = Math.max(1, w - listWidth - 1);
    const rule = style.line("│");
    for (let r = 0; r < bodyH; r++) {
      lines.push(`${sidebar.lines[r] ?? fit("", listWidth)}${rule}${fit(vis[r] ?? "", paneW)}`);
    }
  } else {
    const nav = PANES.map((p) => (p === model.pane ? style.accent(p[0]!.toUpperCase() + p.slice(1)) : style.dim(p[0]!.toUpperCase() + p.slice(1)))).join(style.dim("  "));
    lines.push(fit(` ${nav}`, w));
    const room = Math.max(1, h - lines.length - compose.length);
    for (let r = 0; r < room; r++) lines.push(fit(vis[r] ?? "", w));
  }
  const composeTop = lines.length;
  lines.push(...compose);
  while (lines.length < h) lines.push(fit("", w));
  return {
    lines: lines.slice(0, h),
    sidebar,
    listWidth,
    composeTop,
    cursorRow: composeTop + box.cursorRow,
    cursorCol: box.cursorCol,
  };
}

// ---------------------------------------------------------------- the console

export interface ConsoleOptions {
  /** How to start AgentBrain itself in the background (for dispatch and the control room). */
  self: { command: string; args: string[] };
  /** How connected tools should start AgentBrain's MCP server. */
  config?: { command: string; args: string[] };
}

const CONNECTOR_HEADINGS: Record<ConnectorKind, string> = {
  terminal: "Terminal agents",
  app: "Desktop apps",
  ide: "IDEs",
  extension: "IDE extensions",
};

const CONNECTOR_KIND_ORDER: ConnectorKind[] = ["terminal", "app", "ide", "extension"];

const CAPABILITY_TEXT: Record<Capability, string> = {
  start: "can start tasks",
  pickup: "picks up tasks",
  review: "plans & reviews",
  none: "can't connect",
};

function connectorStatus(connector: Connector): string {
  if (connector.signedIn === false) return `not signed in${connector.hint ? `: ${connector.hint}` : ""}`;
  return connector.connected ? "connected" : "not connected";
}

function connectorTarget(connector: Connector): string {
  if (connector.connect && "file" in connector.connect) return `${connector.connect.scope} config ${connector.connect.file}`;
  if (connector.connect && "manual" in connector.connect) return connector.connect.manual;
  return connector.note ?? "";
}

export function connectorLines(connectors: Connector[], width = 100): string[] {
  const installed = connectors.filter((connector) => connector.installed);
  const lines: string[] = ["", style.bold(" Connectors")];
  if (!installed.length) return [...lines, style.dim("  No installed tools found."), ""];
  for (const kind of CONNECTOR_KIND_ORDER) {
    const group = installed.filter((connector) => connector.kind === kind);
    if (!group.length) continue;
    lines.push("", `  ${style.bold(CONNECTOR_HEADINGS[kind])}`);
    for (const connector of group) {
      const dot = connector.connected ? style.green("●") : style.dim("○");
      const details = [
        connectorStatus(connector),
        CAPABILITY_TEXT[connector.capability],
        connectorTarget(connector),
      ].filter(Boolean).join(" · ");
      lines.push(fit(`  ${dot} ${style.accent(connector.id.padEnd(16))} ${connector.name} ${style.dim(details)}`, width));
    }
  }
  lines.push("");
  return lines;
}

export async function runConsole(root: string, options: ConsoleOptions): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  const write = (s: string) => out.write(s);
  const width = () => Math.max(40, out.columns || 80);
  const height = () => Math.max(12, out.rows || 24);

  let buffer = "";
  let cursor = 0;
  let selected = 0;
  let pane: Pane = "tasks";
  let selectedId: string | undefined;
  let scroll: number | undefined;
  let log: string[] = [];
  let status = "";
  let exitArmed = 0;
  const history: string[] = [];
  let historyIndex = -1;
  let frame: RoomFrame | null = null;

  const objectives = new Map<string, string>();
  const objective = (taskId?: string) => {
    if (!taskId) return undefined;
    if (!objectives.has(taskId)) {
      try { objectives.set(taskId, getTask(root, taskId).objective); } catch { return undefined; }
    }
    return objectives.get(taskId);
  };
  const feed = new FeedFormatter(objective, () => width() - 1);

  const decidesText = () => {
    const p = reviewPolicy(root);
    if (p.mode === "lead") return `lead ${agentLabel(p.reviewers[0])}`;
    if (p.mode === "council") return `council of ${p.reviewers.length} (quorum ${Math.round(p.quorum * 100)}%, survives ${faultTolerance(p.reviewers.length, p.quorum)})`;
    return "you (no reviewers set: /lead or /council)";
  };

  // Which agent the next prompt goes to: "auto" (best-placed ready agent) or one the
  // developer picked with Shift+Tab. Like an agent CLI's mode, it lasts for this session.
  let choice = getProject(root).worker ?? "auto";
  let mode: "chat" | "task" = "chat";
  const chatHistory: string[] = [];
  let ranked = rankWorkers(root);
  let rankedAt = Date.now();
  const ready = () => {
    if (Date.now() - rankedAt > 3000) { ranked = rankWorkers(root); rankedAt = Date.now(); }
    return ranked.filter((c) => c.worker.available);
  };
  const choices = () => ["auto", ...ready().map((c) => c.worker.id)];
  /** The agent and mode pills under the prompt box. */
  const pills = (): InputPills => {
    const options = ready();
    const pick = choice === "auto" ? options[0] : options.find((c) => c.worker.id === choice);
    const agent = choice === "auto" ? `Auto → ${pick ? pick.worker.name : "no agent ready"}` : pick?.worker.name ?? choice;
    return { agent, ...(pick ? { agentId: pick.worker.id } : {}), mode };
  };

  /** Who decides, worded as the web's facts row. */
  const decidesFact = () => {
    const p = reviewPolicy(root);
    if (p.mode === "lead") return `Lead: ${agentLabel(p.reviewers[0])}`;
    if (p.mode === "council") {
      const k = faultTolerance(p.reviewers.length, p.quorum);
      return `Council of ${p.reviewers.length} · survives ${k} bad reviewer${k === 1 ? "" : "s"}`;
    }
    return "You decide";
  };

  const team = (): TeamMember[] => {
    const policy = reviewPolicy(root);
    const lead = policy.mode === "lead" ? policy.reviewers[0] : null;
    return rankWorkers(root)
      .filter((c) => c.worker.installed && c.worker.how !== "pull")
      .map((c) => ({ id: c.worker.id, name: c.worker.name, up: c.worker.available, lead: c.worker.id === lead }));
  };

  const orderedTasks = () => sidebarOrder(listTasks(root));

  const selectedTask = (): TaskState | undefined => {
    const tasks = listTasks(root);
    const order = sidebarOrder(tasks);
    if (selectedId && order.some((t) => t.id === selectedId)) return tasks.find((t) => t.id === selectedId);
    selectedId = order[0]?.id;
    return selectedId ? tasks.find((t) => t.id === selectedId) : undefined;
  };

  const taskBody = (w: number): string[] => {
    const task = selectedTask();
    if (!task) return log.length ? log : [style.dim("  No tasks yet. Type a request below.")];
    const snap = snapshot(root, { includeDone: true });
    const live = snap.tasks.find((t) => t.id === task.id);
    const files = live?.git.changedFiles ?? [];
    const remaining = live?.remaining ?? task.remaining;
    const detail = taskDetailLines(
      { ...task, files, remaining: remaining ?? [] },
      w,
      { ...(task.agent ? { agent: agentLabel(task.agent.id) } : {}), action: task.nextAction, now: new Date() },
    );
    return log.length ? [...detail, "", ...log] : detail;
  };

  const activityBody = (w: number): string[] => {
    const events = readActivity(root, 120);
    const story = storyLines(events, w, objective);
    return story.length ? story : [style.dim("  No activity yet.")];
  };

  const teamBody = (w: number): string[] => {
    const sessions = listSessions(root).filter((s) => !s.endedAt);
    const lines: string[] = [` ${style.accent("Team")}`, ""];
    for (const m of team()) {
      const live = sessions.filter((s) => s.agentId === m.id).at(-1);
      const dotted = m.up ? agentPaint(m.id)("●") : style.dim("○");
      lines.push(fit(`  ${dotted} ${m.up ? style.text(m.name) : style.dim(m.name)}${m.lead ? ` ${style.yellow("LEAD")}` : ""}`, w));
      const doing = live?.lastAction;
      if (doing) lines.push(fit(ellipsize(`     ${style.dim(doing)}`, w), w));
      else if (!m.up) lines.push(fit(`     ${style.dim("unavailable")}`, w));
    }
    return lines;
  };

  const paneWidth = () => {
    const cols = width();
    return cols >= NARROW ? Math.max(20, cols - Math.min(40, Math.max(22, Math.floor(cols * 0.34))) - 1) : cols;
  };

  const model = (): RoomModel => {
    const cmds = suggestions(buffer);
    if (selected >= cmds.length) selected = 0;
    const pick = choice === "auto" ? ready()[0] : undefined;
    const why = pick ? `${pick.reasons.slice(0, 2).join(", ")} · ` : "";
    const bodyW = paneWidth();
    const body = pane === "activity" ? activityBody(bodyW) : pane === "team" ? teamBody(bodyW) : taskBody(bodyW);
    return {
      project: path.basename(root) || root,
      tasks: listTasks(root),
      team: team(),
      agentsActive: listSessions(root).filter(sessionPresent).length,
      decides: decidesFact(),
      checks: getProject(root).checks ?? [],
      pane,
      selectedId,
      body,
      scroll,
      buffer,
      cursor,
      pills: pills(),
      commands: cmds,
      selectedCommand: selected,
      status: status || `${why}decides: ${decidesText()} · ctrl-c twice to exit`,
    };
  };

  const draw = () => {
    frame = renderRoom(model(), width(), height());
    write(`${ESC}H${frame.lines.join("\r\n")}${ESC}${frame.cursorRow + 1};${frame.cursorCol + 1}H${ESC}?25h`);
  };

  const redraw = () => draw();
  const print = (lines: string[]) => {
    if (!lines.length) return;
    log.push(...lines);
    if (log.length > 400) log = log.slice(-300);
    scroll = undefined;
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
    const w = width() - 1;
    const lines = ["", ` ${style.accent("Tasks")}`];
    const reviewCount = tasks.filter((t) => t.status === "review").length;
    const activeCount = tasks.filter((t) => t.status !== "review").length;
    lines.push(style.dim(`  ${activeCount} active · ${reviewCount} waiting for your decision`));
    if (!tasks.length) lines.push(style.dim("  Nothing in progress."));
    for (const t of tasks) {
      const live = sessions.find((s) => s.taskId === t.id && s.mode === "headless" && sessionAlive(s));
      const action = t.status === "review"
        ? `Decide: /approve ${t.id} or /changes ${t.id} <what to fix>`
        : t.status === "running"
          ? live ? `Watch: /live ${t.id}` : "Agent is working; wait for its next update"
          : t.status === "handoff" || t.status === "idle"
            ? `Continue: /continue ${t.id}`
            : t.status === "blocked" || t.status === "failed"
              ? `Needs attention: inspect /status, then /continue ${t.id}`
              : "AgentBrain is tracking this task";
      lines.push("", ...taskCard(t, w, { ...(t.agent ? { agent: agentLabel(t.agent.id) } : {}), action }));
    }
    lines.push("", ` ${style.accent("Agents")}`);
    const recent = sessions.filter((s) => s.lastSeenAt || s.mode === "headless").slice(-6);
    if (!recent.length) lines.push(style.dim("  No agent sessions reporting right now."));
    for (const s of recent) lines.push(ellipsize(`  ${agentPaint(s.agentId)("●")} ${style.text(agentLabel(s.agentId).padEnd(18))} ${style.muted(s.activity ?? (s.mode ?? ""))} ${style.dim(s.lastAction ? short(s.lastAction, 60) : "")}`, w));
    lines.push("", ` ${style.dim("Decides")} ${decidesText()}`, "");
    return lines;
  };

  const liveReport = (arg?: string): string[] => {
    const sessions = listSessions(root).filter((s) => s.mode === "headless" && sessionAlive(s));
    const selected = arg ? sessions.filter((s) => s.taskId === arg || s.taskId.endsWith(arg)) : sessions;
    if (!selected.length) return ["", style.dim("  No headless agent is running right now."), style.dim("  Start one with: agentbrain run <agent> <task> --headless --detach"), ""];
    const lines = ["", style.bold(` Live heads (${selected.length})`)];
    for (const session of selected) {
      const control = sessionControl(root, session.agentId, session.sessionId);
      const transcript = session.transcript ?? control.transcript;
      const tail = fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8").trim().split("\n").slice(-8) : [];
      lines.push(`  ${style.green("●")} ${agentLabel(session.agentId)} · ${session.taskId}`);
      lines.push(style.dim(`    session ${session.sessionId} · attach: agentbrain attach ${session.sessionId}`));
      if (session.lastAction) lines.push(`    ${style.bold("Now:")} ${short(session.lastAction, 90)}`);
      if (tail.length) lines.push(style.dim(`    ${tail.join("\n    ")}`));
    }
    lines.push("", style.dim("  The console keeps this head live; /message <agent> <text> sends guidance."), "");
    return lines;
  };

  const reviewReport = (arg?: string): string[] => {
    const tasks = arg ? [pickTask(arg, () => true)].filter(Boolean) as TaskState[] : pendingReviews(root);
    if (!tasks.length) return ["", style.dim("  Nothing is waiting for review."), ""];
    const w = width() - 1;
    const lines: string[] = [];
    for (const task of tasks) {
      const by = task.review?.worker ?? task.agent?.id;
      lines.push("", ...taskCard(task, w, by ? { agent: `finished by ${agentLabel(by)}` } : {}));
      const md = new MarkdownStream(w, "   ");
      for (const line of reviewSummary(root, task).split("\n")) {
        if (line.startsWith("###")) continue; // the card says it
        if (md.inFence) lines.push(...md.push(line));
        else if (line.startsWith("- PASS")) lines.push(ellipsize(`   ${style.green("✓")} ${style.text(line.slice(7))}`, w));
        else if (line.startsWith("- FAIL")) lines.push(ellipsize(`   ${style.red("✗")} ${style.red(line.slice(7))}`, w));
        else if (/flag/i.test(line)) lines.push(...wrapText(line, w - 3).map((l) => `   ${style.red(l)}`));
        else if (/^[A-Z][^:]*:$/.test(line)) lines.push(`   ${style.muted(line)}`);
        else lines.push(...md.push(line));
      }
      lines.push(...md.end());
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
      case "now":
        return statusReport();
      case "live":
        return liveReport(words[0]);
      case "mode":
        if (!words[0] || words[0] === mode) return [`  Mode: ${style.bold(mode)} · ${mode === "chat" ? "root access, no task created" : "isolated worktree tasks"}`];
        if (words[0] !== "chat" && words[0] !== "task") return [style.yellow("  /mode chat or /mode task")];
        mode = words[0];
        return [style.green(`  ✓ ${mode === "chat" ? "Chat mode: prompts stay conversational in the project root." : "Task mode: prompts create isolated worktree tasks."}`)];
      case "task": {
        const prompt = words.join(" ");
        if (!prompt) return [style.yellow("  /task <request>   creates an isolated worktree task")];
        const result = delegate(root, { prompt, requestedBy: "developer", ...(choice === "auto" ? {} : { worker: choice }) }, options.self);
        objectives.set(result.task.id, result.task.objective);
        return [style.green(`  ✓ Delegated ${result.task.id} to ${result.worker.name}.`), style.dim("    /now shows what happens next.")];
      }
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
      case "plan": {
        if (!rest) return [style.yellow("  /plan <goal>   e.g. /plan add OAuth login with Google and GitHub")];
        const result = planGoal(root, rest, options.self);
        return [style.dim(`    ${result.worker.name} is reading the code and splitting it into pieces; they'll show up here as they're delegated.`)];
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
      case "connectors":
        return connectorLines(detectConnectors(root), width() - 1);
      case "connect": {
        if (!words[0]) return [style.yellow("  /connect <id>   e.g. /connect codex")];
        try {
          const config = options.config ?? options.self;
          const result = connectConnector(root, words[0], config.command, [...config.args, "mcp"]);
          const connector = detectConnectors(root, { all: true }).find((c) => c.id === words[0]);
          const name = connector?.name ?? words[0];
          return [
            style.green(`  ✓ ${result.action} ${result.file}`),
            style.dim(`  restart ${name} so it loads AgentBrain`),
          ];
        } catch (error) {
          return [style.yellow(`  ${error instanceof Error ? error.message : String(error)}`)];
        }
      }
      case "disconnect": {
        if (!words[0]) return [style.yellow("  /disconnect <id>   e.g. /disconnect codex")];
        try {
          const changed = disconnectConnector(root, words[0]);
          return [changed ? style.green(`  ✓ Disconnected ${words[0]}.`) : style.dim(`  ${words[0]} was not connected.`)];
        } catch (error) {
          return [style.yellow(`  ${error instanceof Error ? error.message : String(error)}`)];
        }
      }
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
        log = [];
        scroll = undefined;
        return [];
      case "exit":
      case "quit":
        quit();
        return [];
      default:
        return [style.yellow(`  Unknown command /${rawName}. /help lists them.`)];
    }
  };

  let confirmShort = "";
  const submit = async () => {
    const line = buffer.trim();
    buffer = "";
    cursor = 0;
    selected = 0;
    if (!line) return redraw();
    history.unshift(line);
    historyIndex = -1;
    print(["", ...userBubble(line, width() - 1)]);
    try {
      const word = line.toLowerCase();
      if (line.startsWith("/")) print(await run(line));
      // A bare command name ("clear", "help", "status", "agentbrain") is that command, not a task.
      else if (/^\S+$/.test(line) && (word === "agentbrain" || COMMANDS.some((c) => c.name === word))) print(await run(word === "agentbrain" ? "/help" : `/${word}`));
      else if (mode === "task" && line.split(/\s+/).length < 3 && confirmShort !== line) {
        // Too short to be a real task more often than not: ask once.
        confirmShort = line;
        print([style.yellow(`    That's a very short task. Press Enter on it again to delegate "${line}", or describe it in more detail.`)]);
        buffer = line;
        cursor = [...line].length;
        return redraw();
      } else if (mode === "task") {
        confirmShort = "";
        const result = delegate(root, { prompt: line, requestedBy: "developer", ...(choice === "auto" ? {} : { worker: choice }) }, options.self);
        objectives.set(result.task.id, result.task.objective);
        if (result.worker.how === "pull") print([`    ${style.dim("Open any agent on this repo (Claude app, Cursor, VS Code) and say \"continue\"; it picks this up.")}`]);
      } else {
        const selected = choice === "auto" ? ready()[0]?.worker : ready().find((c) => c.worker.id === choice)?.worker;
        if (!selected) throw new Error("No selected model is ready. Use Shift+Tab or /worker to choose one.");
        if (selected.how !== "print") throw new Error(`${selected.name} is a chat connector. Select Claude Code, Codex or the local model for root Chat mode.`);
        const agent = printAgent(selected.id);
        const prompt = [...chatHistory, `Developer: ${line}`].join("\n");
        print(["", `${agentTag(selected.id, selected.name)}  ${style.dim("Chat · project root")}`]);
        // Pieces arrive token by token from a local model: print whole lines as they complete.
        const md = new MarkdownStream(width() - 1);
        let pending = "";
        await runChat(root, agent, `${chatBrief(root, line)}\n\n${prompt}`, (text) => {
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          if (lines.length) print(lines.flatMap((part) => md.push(part)));
        });
        print([...(pending ? md.push(pending) : []), ...md.end()]);
        chatHistory.push(`Developer: ${line}`);
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
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    write(`${ESC}?25h${ESC}?1049l`);
    write(style.dim("Agents keep working in the background. `agentbrain` brings you back.\n"));
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
    if (key?.name === "tab" && !options.length && !buffer) {
      pane = PANES[(PANES.indexOf(pane) + 1) % PANES.length];
      scroll = undefined;
      return redraw();
    }
    if (key?.name === "pageup") {
      scroll = Math.max(0, (scroll ?? 0) - 10);
      return redraw();
    }
    if (key?.name === "pagedown") {
      scroll = (scroll ?? 0) + 10;
      return redraw();
    }
    if (!buffer && !options.length && key?.name === "o") {
      const task = selectedTask();
      if (task) {
        try {
          openInEditor(taskWorkdir(root, task));
          status = `Opened ${taskWorkdir(root, task)} in VS Code`;
        } catch (error) {
          status = (error as Error).message;
        }
      }
      return redraw();
    }
    if (!buffer && !options.length && key?.name === "s") {
      const task = selectedTask();
      const live = task ? listSessions(root).find((s) => s.taskId === task.id && s.mode === "headless" && sessionAlive(s)) : undefined;
      if (!live) status = "No headless agent is running on this task.";
      else {
        requestStop(root, live.agentId, live.sessionId);
        status = `Asked ${live.agentId} to stop; the task will be handed off.`;
      }
      return redraw();
    }
    if (!buffer && !options.length && key?.name === "q") return quit();
    if (!buffer && !options.length && key?.name === "m") {
      const task = selectedTask();
      const live = task ? listSessions(root).find((s) => s.taskId === task.id && s.mode === "headless" && sessionAlive(s)) : undefined;
      if (!live) {
        status = "No headless agent is running on this task to message. Type /message <agent> <text>.";
        return redraw();
      }
      buffer = `/message ${live.agentId} `;
      cursor = [...buffer].length;
      return redraw();
    }
    if (key?.name === "up") {
      if (options.length) selected = (selected - 1 + options.length) % options.length;
      else if (buffer || historyIndex >= 0) {
        if (history.length) { historyIndex = Math.min(historyIndex + 1, history.length - 1); buffer = history[historyIndex]; cursor = [...buffer].length; }
      } else {
        const order = orderedTasks();
        const i = Math.max(0, order.findIndex((t) => t.id === selectedId));
        selectedId = order[Math.max(0, i - 1)]?.id ?? selectedId;
        scroll = undefined;
      }
      return redraw();
    }
    if (key?.name === "down") {
      if (options.length) selected = (selected + 1) % options.length;
      else if (buffer || historyIndex >= 0) {
        if (historyIndex > 0) { historyIndex--; buffer = history[historyIndex]; cursor = [...buffer].length; }
        else { historyIndex = -1; buffer = ""; cursor = 0; }
      } else {
        const order = orderedTasks();
        const i = Math.max(0, order.findIndex((t) => t.id === selectedId));
        selectedId = order[Math.min(order.length - 1, i + 1)]?.id ?? selectedId;
        scroll = undefined;
      }
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
  let resizeTimer: NodeJS.Timeout | null = null;
  out.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 80);
  });

  // ------------------------------------------------------------ start

  write(`${ESC}?1049h${ESC}?25h`);
  if (pendingReviews(root).length) {
    log.push(style.dim("  /review to inspect · /approve · /changes <what to fix>"));
  }
  draw();
}
