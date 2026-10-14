/**
 * `agentbrain` with no arguments: a live terminal view of every task and
 * agent. Rendering (renderFrame) is pure and separate from terminal I/O
 * (runTui), so it can be tested without a terminal.
 */
import { requestStop, sendToSession } from "../core/headless.js";
import { routeTask } from "../core/routing.js";
import { taskTimeline } from "../core/timeline.js";
import { openInEditor } from "./open.js";
import { snapshot, taskDiff, transcriptTail, watchProject, type LiveTask, type Snapshot } from "./model.js";

export type View = "overview" | "changes" | "live" | "timeline" | "route" | "review" | "activity";
export const VIEWS: View[] = ["overview", "changes", "live", "timeline", "route", "review", "activity"];

export interface TuiState {
  selected: number;
  view: View;
  scroll: number;
  showDone: boolean;
  /** Text being typed as a message to a headless agent, or null. */
  input: string | null;
  flash: string;
}

export const initialState = (): TuiState => ({ selected: 0, view: "overview", scroll: 0, showDone: false, input: null, flash: "" });

// ---------------------------------------------------------------- text helpers

const ESC = "\x1b[";
const c = (code: string, text: string) => (noColor() && code !== "1" && code !== "7" ? text : `${ESC}${code}m${text}${ESC}0m`);
const dim = (t: string) => c("2", t);
const bold = (t: string) => c("1", t);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

// ---------------------------------------------------------------- palette (same as the web control room)

/** NO_COLOR (any value) turns colour off entirely; https://no-color.org */
export function noColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== "";
}

export function colorMode(env: NodeJS.ProcessEnv = process.env): "none" | "truecolor" | "256" {
  if (noColor(env)) return "none";
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") ? "truecolor" : "256";
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The nearest xterm-256 colour: the 6x6x6 cube or the grey ramp, whichever is closer. */
export function to256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const steps = [0, 95, 135, 175, 215, 255];
  const near = (v: number) => steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);
  const [ri, gi, bi] = [near(r), near(g), near(b)];
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (steps[ri] - r) ** 2 + (steps[gi] - g) ** 2 + (steps[bi] - b) ** 2;
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const level = 8 + grey * 10;
  const greyDist = (level - r) ** 2 + (level - g) ** 2 + (level - b) ** 2;
  return greyDist < cubeDist ? 232 + grey : cube;
}

/** Paints text in a hex colour: truecolor when the terminal says so, else 256 colours, else nothing. */
export function hexPaint(hex: string): (text: string) => string {
  return (text) => {
    const mode = colorMode();
    if (mode === "none" || !text) return text;
    const code = mode === "truecolor" ? `38;2;${rgb(hex).join(";")}` : `38;5;${to256(hex)}`;
    return `${ESC}${code}m${text}${ESC}0m`;
  };
}

export const HEX = {
  text: "#ededed",
  muted: "#a1a1a1",
  faint: "#6b6b6b",
  line: "#2a2a2a",
  review: "#e8b84a",
  running: "#3cc7bd",
  waiting: "#f0883e",
  failed: "#f2564c",
  ok: "#3fb968",
  done: "#b48cf2",
} as const;

export const ui = {
  text: hexPaint(HEX.text),
  muted: hexPaint(HEX.muted),
  faint: hexPaint(HEX.faint),
  line: hexPaint(HEX.line),
  review: hexPaint(HEX.review),
  running: hexPaint(HEX.running),
  waiting: hexPaint(HEX.waiting),
  failed: hexPaint(HEX.failed),
  ok: hexPaint(HEX.ok),
  done: hexPaint(HEX.done),
  bold,
};

/** Agent colours from the web PALETTE, with the same hash, so an agent has one colour everywhere. */
export const PALETTE = ["#a1a1aa", "#3fb968", "#b48cf2", "#e8b84a", "#f2564c", "#3cc7bd", "#f07ab4"];

export function agentHex(id: string): string {
  if (id === "developer" || id === "agentbrain" || id === "council") return HEX.text;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export const agentPaint = (id: string) => hexPaint(agentHex(id));

export interface StateTone {
  /** What to call the state on a card. */
  label: string;
  hex: string;
}

/** One colour per state, as the web's status dots: review amber, running teal, waiting orange… */
export function stateTone(task: { status: string; nextAction?: string; merged?: unknown }): StateTone {
  switch (task.status) {
    case "review":
      return { label: "review", hex: HEX.review };
    case "running":
    case "checkpoint":
      return { label: task.status, hex: HEX.running };
    case "handoff":
      return { label: "handoff", hex: HEX.waiting };
    case "idle":
      return { label: "waiting", hex: HEX.waiting };
    case "blocked":
    case "failed":
      return { label: task.status, hex: HEX.failed };
    case "done":
      if (/^Closed/.test(task.nextAction ?? "")) return { label: "closed", hex: HEX.faint };
      return task.merged ? { label: "merged", hex: HEX.ok } : { label: "done", hex: HEX.done };
    default:
      return { label: task.status, hex: HEX.muted };
  }
}

/** A coloured ● for a task's state. */
export function stateDot(task: { status: string; nextAction?: string; merged?: unknown }): string {
  return hexPaint(stateTone(task).hex)("●");
}

/** The first sentence or clause of an objective, as the web's task titles. */
export function shortTitle(objective: string): string {
  let first = String(objective).split(/(?<=[.!?])\s|:\s|\n/)[0];
  if (first.length > 90) first = `${first.slice(0, 87).replace(/\s+\S*$/, "")}…`;
  return first;
}

/** Cuts styled text to `width` visible characters, ending in … when anything was cut. */
export function ellipsize(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  return `${fit(text, width - 1).replace(/ +$/, "")}…`;
}

/** Compact age: now, 5m, 3h, 2d. */
export function age(iso: string | undefined, now = new Date()): string {
  return ago(iso, now);
}

/** Local HH:MM of a timestamp. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Truncates to `width` visible characters (keeping escape codes) and pads. */
export function fit(text: string, width: number): string {
  let out = "";
  let visible = 0;
  for (let i = 0; i < text.length && visible < width; ) {
    ANSI.lastIndex = i;
    const match = ANSI.exec(text);
    if (match && match.index === i) {
      out += match[0];
      i += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    out += ch;
    i += ch.length;
    visible++;
  }
  return `${out}${out.includes("\x1b") ? `${ESC}0m` : ""}${" ".repeat(Math.max(0, width - visible))}`;
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (visibleLength(line) + visibleLength(word) + 1 > width && line) {
        lines.push(line);
        line = "";
      }
      line = line ? `${line} ${word}` : word;
      while (visibleLength(line) > width) {
        lines.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    lines.push(line);
  }
  return lines;
}


const ACTIVITY_GLYPH: Record<string, string> = {
  session: "◉",
  prompt: "?",
  tool: "◇",
  edit: "✎",
  command: "$",
  commit: "◆",
  status: "●",
  decision: "!",
  progress: "→",
  handoff: "⇄",
  review: "✓",
  message: "✉",
};

function dot(task: LiveTask): string {
  if (task.warning) return ui.waiting("●");
  return stateDot(task);
}

function ago(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function shortTime(iso: string | undefined): string {
  return iso ? iso.slice(5, 16).replace("T", " ") : "";
}

function viewHelp(): string {
  return `1-${VIEWS.length}/←→ view`;
}

// ---------------------------------------------------------------- detail views

function section(title: string, items: string[], numbered = false, width = 80): string[] {
  if (!items.length) return [];
  return [
    bold(title),
    ...items.flatMap((item, i) => wrap(`${numbered ? `${i + 1}.` : "-"} ${item}`, width - 2).map((l, j) => (j ? `   ${l}` : ` ${l}`))),
    "",
  ];
}

export function detailLines(root: string, task: LiveTask, view: View, width: number): string[] {
  switch (view) {
    case "overview": {
      const lines = [
        ...wrap(bold(task.objective), width),
        `${hexPaint(stateTone(task).hex)(task.status)}  ${dim("agent")} ${task.agent ?? "none"}  ${dim("id")} ${task.id}`,
        task.worktree ? `${dim("worktree")} ${task.worktree.branch}` : `${dim("dir")} ${task.workdir}`,
        "",
      ];
      if (task.warning) lines.push(...wrap(c("33", `⚠ ${task.warning}`), width), "");
      if (task.liveSession) {
        lines.push(c("32", `▶ ${task.liveSession.agentId} is running headless (${task.liveSession.sessionId}) — press 3 to watch, m to message`), "");
      }
      if (task.nextAction) lines.push(bold("Next"), ...wrap(` ${task.nextAction}`, width), "");
      lines.push(
        ...section("Remaining", task.remaining, true, width),
        ...section("Blockers", task.blockers, false, width),
        ...section("Known failures", task.failures, true, width),
        ...section("Decisions", task.decisions.slice(-8), false, width),
        ...section("Completed", task.completed.slice(-10), false, width),
      );
      return lines;
    }
    case "changes": {
      const files = task.git.changedFiles;
      const lines = [bold(`Uncommitted changes in ${task.git.branch ?? "(detached)"}`), ...(files.length ? files.map((f) => ` ${f}`) : [dim(" none")]), ""];
      for (const line of taskDiff(task.workdir).split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) lines.push(c("32", line));
        else if (line.startsWith("-") && !line.startsWith("---")) lines.push(c("31", line));
        else if (line.startsWith("@@")) lines.push(c("36", line));
        else lines.push(line);
      }
      return lines;
    }
    case "live": {
      const session = task.liveSession;
      if (!session) {
        return [
          bold("No headless agent is running on this task."),
          "",
          ...wrap(
            "Agents in an IDE or terminal show their work in their own window: press o to bring up the task's folder in VS Code (nothing is stopped). Start a background agent with: agentbrain run <agent> " +
              `${task.id} --headless --detach --linger 15`,
            width,
          ),
        ];
      }
      return [
        `${c("32", "▶")} ${bold(session.agentId)} ${dim(session.sessionId)}  ${dim("m: message  s: stop")}`,
        "",
        ...transcriptTail(session.transcript, 400).flatMap((l) => wrap(l.replace(/^\[[^\]]+\] /, ""), width)),
      ];
    }
    case "timeline":
      return taskTimeline(root, task.id).map((e) => `${dim(e.timestamp.slice(5, 16).replace("T", " "))} ${e.agent.padEnd(12)} ${e.event.padEnd(10)} ${e.reason}`);
    case "route": {
      const lines = [bold("Who should take this task next?"), ""];
      routeTask(root, task.id)
        .filter((r) => r.available)
        .forEach((r, i) => {
          lines.push(`${i + 1}. ${bold(r.name)} ${dim(`[${r.mode}] score ${r.score}`)}`);
          for (const reason of r.reasons) lines.push(...wrap(`   - ${reason}`, width));
          lines.push(dim(`   $ ${r.command}`), "");
        });
      return lines;
    }
    case "review":
    case "activity":
      return [];
  }
}

function reviewLines(snap: Snapshot, width: number): string[] {
  const tasks = snap.tasks.filter((task) => task.status === "review");
  if (!tasks.length) return [bold("No tasks are waiting for review.")];
  const lines: string[] = [bold(`Review (${tasks.length})`), ""];
  for (const task of tasks) {
    const review = task.review;
    const tally = task.tally;
    lines.push(...wrap(`${bold(task.id)} by ${review?.worker ?? task.agent ?? "unknown"}: ${task.objective}`, width));
    if (review?.checks?.length) {
      for (const check of review.checks) lines.push(...wrap(` ${check.ok ? "✓" : "✗"} ${check.command}`, width));
    } else {
      lines.push(dim(" no checks recorded"));
    }
    for (const flag of review?.flags ?? []) {
      lines.push(...wrap(` ⚠ ${flag.kind}: ${flag.text} (${flag.agent})`, width).map((line) => c("31", line)));
    }
    if (tally) {
      const vote = ` tally ${tally.approve}/${tally.changes} of ${tally.total} approve/changes`;
      lines.push(...wrap(`${dim(vote)}${tally.blocked ? c("31", ` · blocked: ${tally.blocked}`) : ""}`, width));
    }
    lines.push("");
  }
  return lines;
}

function activityLines(snap: Snapshot, width: number): string[] {
  if (!snap.activity.length) return [bold("No activity yet.")];
  return [
    bold("Activity"),
    "",
    ...[...snap.activity].reverse().map((event) => {
      const glyph = ACTIVITY_GLYPH[event.kind] ?? "·";
      return fit(`${dim(shortTime(event.at))} ${event.agent.padEnd(12)} ${glyph} ${event.text}`, width);
    }),
  ];
}

function bodyLines(root: string, snap: Snapshot, selected: LiveTask | undefined, view: View, width: number): string[] {
  if (view === "review") return reviewLines(snap, width);
  if (view === "activity") return activityLines(snap, width);
  return selected ? detailLines(root, selected, view, width) : [dim("Nothing selected.")];
}

// ---------------------------------------------------------------- sidebar (the web control room's left column)

/** What the main pane of the full-screen console shows, as the web's nav. */
export type Pane = "tasks" | "chat" | "activity" | "team";
export const PANES: Pane[] = ["tasks", "chat", "activity", "team"];
export const PANE_LABELS: Record<Pane, string> = { tasks: "Tasks", chat: "Chat", activity: "Activity", team: "Team" };

export interface SidebarTask {
  id: string;
  objective: string;
  status: string;
  updatedAt?: string;
  nextAction?: string;
  merged?: unknown;
  warning?: string | null;
}

export interface TeamMember {
  id: string;
  name: string;
  /** Installed and ready. */
  up: boolean;
  lead?: boolean;
}

export interface TaskGroups<T> {
  /** Waiting on the developer: review, handoff, blocked, failed (review first). */
  needs: T[];
  /** An agent is on it: running, checkpoint, idle. */
  progress: T[];
  /** Finished, newest first. */
  recent: T[];
}

const NEEDS_YOU = ["review", "handoff", "blocked", "failed"];
const WORKING = ["running", "checkpoint", "idle"];

/** Splits tasks into the web sidebar's groups, keeping the given order inside a group. */
export function groupTasks<T extends SidebarTask>(tasks: T[], recent = 8): TaskGroups<T> {
  return {
    needs: tasks.filter((t) => NEEDS_YOU.includes(t.status)).sort((a, b) => Number(b.status === "review") - Number(a.status === "review")),
    progress: tasks.filter((t) => WORKING.includes(t.status)),
    recent: tasks
      .filter((t) => t.status === "done")
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, recent),
  };
}

/** The tasks in the order the sidebar shows them; the selection moves through this list. */
export function sidebarOrder<T extends SidebarTask>(tasks: T[], recent = 8): T[] {
  const g = groupTasks(tasks, recent);
  return [...g.needs, ...g.progress, ...g.recent];
}

/**
 * One sidebar row, exactly `width` wide: a marker, the state dot, the short title
 * (faint once done) and the age right-aligned. A focused selection is inverted.
 */
export function sidebarRow(task: SidebarTask, width: number, now = new Date(), selected = false, focused = false): string {
  const when = age(task.updatedAt, now);
  const title = ellipsize(shortTitle(task.objective), Math.max(1, width - 5 - when.length));
  const gap = Math.max(1, width - 4 - visibleLength(title) - when.length);
  const paint = task.status === "done" ? ui.faint : ui.text;
  const mark = selected ? ui.text("›") : " ";
  const row = fit(`${mark}${task.warning ? ui.waiting("●") : stateDot(task)} ${selected ? bold(paint(title)) : paint(title)}${" ".repeat(gap)}${ui.faint(when)} `, width);
  return selected && focused ? c("7", fit(stripAnsi(row), width)) : row;
}

export interface TaskList {
  lines: string[];
  /** Line index -> task id, for the rows that are tasks. */
  rows: Map<number, string>;
  /** Line of the selected task, or -1. */
  selectedLine: number;
}

/** The grouped task list: "Needs you", "In progress", "Recent", each with its rows. */
export function taskListLines(
  tasks: SidebarTask[],
  width: number,
  options: { selectedId?: string; focused?: boolean; recent?: number; now?: Date } = {},
): TaskList {
  const g = groupTasks(tasks, options.recent);
  const lines: string[] = [];
  const rows = new Map<number, string>();
  let selectedLine = -1;
  const group = (title: string, list: SidebarTask[], always = false) => {
    if (!list.length && !always) return;
    if (lines.length) lines.push(fit("", width));
    lines.push(fit(` ${bold(ui.muted(title))}${list.length ? ` ${ui.faint(String(list.length))}` : ""}`, width));
    if (!list.length) lines.push(fit(`   ${ui.faint("Nothing finished yet.")}`, width));
    for (const task of list) {
      const selected = task.id === options.selectedId;
      if (selected) selectedLine = lines.length;
      rows.set(lines.length, task.id);
      lines.push(sidebarRow(task, width, options.now, selected, options.focused));
    }
  };
  if (!tasks.length) lines.push(fit(` ${ui.faint("No tasks yet.")}`, width));
  else {
    group("Needs you", g.needs);
    group("In progress", g.progress);
    group("Recent", g.recent, true);
  }
  return { lines, rows, selectedLine };
}

/** The window of `size` lines out of `total` that keeps `line` in view. */
export function windowAround(total: number, size: number, line: number): number {
  if (total <= size || line < 0) return 0;
  return Math.max(0, Math.min(line - Math.floor(size / 3), total - size));
}

/** The team pinned under the sidebar: each worker's dot and name, LEAD on the lead, dim when unavailable. */
export function teamBlock(team: TeamMember[], width: number): string[] {
  if (!team.length) return [];
  const lines = [fit(` ${bold(ui.muted("Team"))}`, width)];
  for (const m of team) {
    const badge = m.lead ? "LEAD" : "";
    const name = ellipsize(m.name, Math.max(1, width - 5 - (badge ? badge.length + 1 : 0)));
    const dotted = m.up ? agentPaint(m.id)("●") : ui.faint("○");
    lines.push(fit(`  ${dotted} ${m.up ? ui.text(name) : ui.faint(name)}${badge ? ` ${ui.review(badge)}` : ""}`, width));
  }
  return lines;
}

export interface SidebarInput {
  tasks: SidebarTask[];
  team: TeamMember[];
  pane: Pane;
  selectedId?: string;
  /** The sidebar has the keyboard: the selection is inverted. */
  focused?: boolean;
  /** How many done tasks Recent shows. */
  recent?: number;
  now?: Date;
}

export interface Sidebar {
  /** Exactly `height` lines, each exactly `width` wide. */
  lines: string[];
  /** Sidebar line -> task id. */
  rows: Map<number, string>;
  /** Sidebar line -> nav item. */
  nav: Map<number, Pane>;
}

/** The left column: nav, the grouped task list (scrolled to keep the selection in view), the team pinned at the bottom. */
export function sidebarLines(input: SidebarInput, width: number, height: number): Sidebar {
  const needs = groupTasks(input.tasks).needs.length;
  const nav = new Map<number, Pane>();
  const top: string[] = [];
  for (const pane of PANES) {
    nav.set(top.length, pane);
    const on = pane === input.pane;
    const count = pane === "tasks" && needs ? ui.review(String(needs)) : "";
    const label = on ? `${ui.text("›")} ${bold(ui.text(PANE_LABELS[pane]))}` : `  ${ui.muted(PANE_LABELS[pane])}`;
    const gap = Math.max(1, width - 2 - visibleLength(label) - visibleLength(count));
    top.push(fit(` ${label}${" ".repeat(gap)}${count} `, width));
  }
  top.push(fit("", width));

  let team = teamBlock(input.team, width);
  if (height - top.length - team.length - 1 < 3) team = [];
  const room = Math.max(0, height - top.length - (team.length ? team.length + 1 : 0));
  const list = taskListLines(input.tasks, width, { selectedId: input.selectedId, focused: input.focused, recent: input.recent, now: input.now });
  const from = windowAround(list.lines.length, room, list.selectedLine);
  const body = list.lines.slice(from, from + room);
  if (from > 0 && body.length) body[0] = fit(` ${ui.faint("↑ more")}`, width);
  if (from + room < list.lines.length && body.length) body[body.length - 1] = fit(` ${ui.faint("↓ more")}`, width);

  const rows = new Map<number, string>();
  for (const [line, id] of list.rows) {
    const at = line - from;
    if (at >= 0 && at < body.length && !(at === 0 && from > 0) && !(at === body.length - 1 && from + room < list.lines.length)) rows.set(top.length + at, id);
  }
  const lines = [...top, ...body];
  while (lines.length < height - (team.length ? team.length + 1 : 0)) lines.push(fit("", width));
  if (team.length) lines.push(fit("", width), ...team);
  return { lines: lines.slice(0, height), rows, nav };
}

// ---------------------------------------------------------------- frame

export interface Frame {
  lines: string[];
  /** Screen rows of list entries, for mouse clicks: row -> task index. */
  listRows: Map<number, number>;
  /** Screen columns of view tabs on the tab row. */
  tabs: { view: View; from: number; to: number }[];
  tabRow: number;
  listWidth: number;
}

/** Below this width the list and details are stacked instead of side by side. */
export const NARROW = 90;

export function renderFrame(root: string, snap: Snapshot, state: TuiState, width: number, height: number, now = new Date()): Frame {
  if (width < NARROW) return renderNarrow(root, snap, state, width, height, now);
  const listWidth = Math.min(44, Math.max(24, Math.floor(width * 0.34)));
  const detailWidth = width - listWidth - 1;
  const tasks = snap.tasks;
  const selected = tasks[Math.min(state.selected, tasks.length - 1)];
  const live = snap.sessions.filter((s) => s.alive).length;

  const queue = snap.queue;
  const header = fit(` ${bold("AgentBrain")}  ${dim(snap.root)}  ${tasks.length} task(s), ${live} agent(s) running headless${queue.length ? `, queue: ${queue.length}` : ""}`, width);
  const tabs: Frame["tabs"] = [];
  let tabLine = " ";
  VIEWS.forEach((v, i) => {
    const label = `${i + 1} ${v}`;
    const from = listWidth + 1 + visibleLength(tabLine);
    tabLine += (v === state.view ? c("7", ` ${label} `) : ` ${label} `) + " ";
    tabs.push({ view: v, from, to: from + label.length + 2 });
  });

  // Left: task list.
  const listRows = new Map<number, number>();
  const list: string[] = [fit(bold(" Tasks"), listWidth)];
  tasks.forEach((task, i) => {
    const row = `${dot(task)} ${task.agent ? `${task.agent.slice(0, 10).padEnd(10)} ` : "".padEnd(11)}${task.objective}`;
    const meta = dim(` ${task.status} · ${ago(task.updatedAt, now)}${task.liveSession ? " · headless" : ""}`);
    const style = (t: string) => (i === state.selected ? c("7", t) : t);
    listRows.set(3 + list.length, i); // screen rows are 1-based; body starts on row 3
    list.push(style(fit(` ${row}`, listWidth)));
    listRows.set(3 + list.length, i); // screen rows are 1-based; body starts on row 3
    list.push(style(fit(` ${meta}`, listWidth)));
  });
  if (queue.length) {
    list.push(bold(" Queued"));
    queue.forEach((item) => list.push(fit(dim(` ${item.objective}`), listWidth)));
  }
  if (!tasks.length) list.push(fit(dim(" No tasks. agentbrain task create \"...\""), listWidth));

  // Right: details for the selected task.
  const body = bodyLines(root, snap, selected, state.view, detailWidth - 1);
  const bodyHeight = height - 3; // header, tab row, footer
  const scroll = Math.max(0, Math.min(state.scroll, Math.max(0, body.length - bodyHeight)));
  const visible = body.slice(scroll, scroll + bodyHeight);

  const lines: string[] = [header, fit(`${" ".repeat(listWidth)}${dim("│")}${tabLine}`, width)];
  for (let r = 0; r < bodyHeight; r++) {
    lines.push(`${fit(list[r] ?? "", listWidth)}${dim("│")} ${fit(visible[r] ?? "", detailWidth - 1)}`);
  }
  const footer =
    state.input !== null
      ? `${c("7", " message ")} ${state.input}█  ${dim("Enter send · Esc cancel")}`
      : state.flash ||
        dim(`↑↓ select · ${viewHelp()} · PgUp/PgDn scroll · o open in VS Code · m message · s stop · d show done · q quit`);
  lines.push(fit(` ${footer}`, width));
  return { lines, listRows, tabs, tabRow: 2, listWidth };
}

function renderNarrow(root: string, snap: Snapshot, state: TuiState, width: number, height: number, now: Date): Frame {
  const tasks = snap.tasks;
  const selected = tasks[Math.min(state.selected, tasks.length - 1)];
  const lines: string[] = [fit(` ${bold("AgentBrain")} ${dim(`${tasks.length} task(s)${snap.queue.length ? `, queue: ${snap.queue.length}` : ""}`)}`, width)];
  const listRows = new Map<number, number>();

  // Compact list, scrolled to keep the selection visible.
  const listHeight = Math.max(3, Math.min(tasks.length, Math.floor((height - 4) / 3)));
  const first = Math.max(0, Math.min(state.selected - listHeight + 1, tasks.length - listHeight));
  for (let i = first; i < Math.min(tasks.length, first + listHeight); i++) {
    const t = tasks[i];
    const row = ` ${dot(t)} ${dim(`${t.status.slice(0, 7).padEnd(7)} ${ago(t.updatedAt, now).padStart(3)}`)} ${t.objective}`;
    listRows.set(lines.length + 1, i);
    lines.push(i === state.selected ? c("7", fit(row, width)) : fit(row, width));
  }
  if (!tasks.length) lines.push(fit(dim(" No tasks yet."), width));
  if (snap.queue.length) {
    lines.push(fit(bold(" Queued"), width));
    // Keep room for the details pane on small terminals.
    for (const item of snap.queue.slice(0, 3)) lines.push(fit(dim(` ${item.objective}`), width));
    if (snap.queue.length > 3) lines.push(fit(dim(` +${snap.queue.length - 3} more`), width));
  }

  const tabs: Frame["tabs"] = [];
  let tabLine = "";
  VIEWS.forEach((v, i) => {
    const label = `${i + 1}${v.slice(0, 4)}`;
    const from = visibleLength(tabLine) + 1;
    tabLine += (v === state.view ? c("7", ` ${label} `) : ` ${label} `);
    tabs.push({ view: v, from, to: from + label.length + 1 });
  });
  const tabRow = lines.length + 1;
  lines.push(fit(tabLine, width));

  const body = bodyLines(root, snap, selected, state.view, width - 1);
  const bodyHeight = height - lines.length - 1;
  const scroll = Math.max(0, Math.min(state.scroll, Math.max(0, body.length - bodyHeight)));
  for (let r = 0; r < bodyHeight; r++) lines.push(fit(` ${body[scroll + r] ?? ""}`, width));
  const footer = state.input !== null ? `${c("7", " msg ")} ${state.input}█` : state.flash || dim(`↑↓ ${viewHelp()} o open m msg s stop q quit`);
  lines.push(fit(` ${footer}`, width));
  return { lines, listRows, tabs, tabRow, listWidth: width };
}

// ---------------------------------------------------------------- input

export type Action =
  | { type: "quit" }
  | { type: "open" }
  | { type: "stop" }
  | { type: "send"; text: string }
  | { type: "none" };

/** Applies one key to the state; returns an action for the I/O layer. */
export function handleKey(state: TuiState, key: string, taskCount: number): Action {
  if (state.input !== null) {
    if (key === "\r") {
      const text = state.input.trim();
      state.input = null;
      return text ? { type: "send", text } : { type: "none" };
    }
    if (key === "\x1b") state.input = null;
    else if (key === "\x7f") state.input = state.input.slice(0, -1);
    else if (key === "\x03") return { type: "quit" };
    else if (key >= " ") state.input += key;
    return { type: "none" };
  }
  const select = (i: number) => {
    state.selected = Math.max(0, Math.min(taskCount - 1, i));
    state.scroll = 0;
  };
  switch (key) {
    case "q":
    case "\x03":
      return { type: "quit" };
    case "\x1b[A":
    case "k":
      select(state.selected - 1);
      break;
    case "\x1b[B":
    case "j":
      select(state.selected + 1);
      break;
    case "\x1b[C":
    case "\t":
      state.view = VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length];
      state.scroll = 0;
      break;
    case "\x1b[D":
      state.view = VIEWS[(VIEWS.indexOf(state.view) + VIEWS.length - 1) % VIEWS.length];
      state.scroll = 0;
      break;
    case "\x1b[5~":
      state.scroll = Math.max(0, state.scroll - 10);
      break;
    case "\x1b[6~":
    case " ":
      state.scroll += 10;
      break;
    case "d":
      state.showDone = !state.showDone;
      break;
    case "o":
      return { type: "open" };
    case "s":
      return { type: "stop" };
    case "m":
      state.input = "";
      break;
    default:
      if (/^[1-9]$/.test(key) && Number(key) <= VIEWS.length) {
        state.view = VIEWS[Number(key) - 1];
        state.scroll = 0;
      }
  }
  return { type: "none" };
}

/** Splits a raw stdin chunk into keys and SGR mouse events. */
export function parseInput(chunk: string): string[] {
  const keys: string[] = [];
  const re = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk))) keys.push(m[0]);
  return keys;
}

// ---------------------------------------------------------------- terminal I/O

export async function runTui(root: string): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  if (!out.isTTY || !input.isTTY) throw new Error("The live view needs an interactive terminal. Try `agentbrain status`.");

  const state = initialState();
  let snap = snapshot(root, { includeDone: state.showDone });
  let frame: Frame | null = null;

  const draw = () => {
    snap = snapshot(root, { includeDone: state.showDone });
    if (state.selected >= snap.tasks.length) state.selected = Math.max(0, snap.tasks.length - 1);
    frame = renderFrame(root, snap, state, out.columns || 100, out.rows || 30);
    out.write(`${ESC}H${frame.lines.join(`\r\n`)}`);
  };
  const flash = (text: string) => {
    state.flash = text;
    draw();
    setTimeout(() => {
      if (state.flash === text) {
        state.flash = "";
        draw();
      }
    }, 4000).unref();
  };

  out.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h${ESC}2J`);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();

  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const stopWatching = watchProject(root, draw);
  const tick = setInterval(draw, 15_000);
  const restore = () => {
    stopWatching();
    clearInterval(tick);
    input.setRawMode(false);
    input.pause();
    out.write(`${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`);
  };
  process.on("SIGWINCH", draw);

  const act = (action: Action) => {
    const task = snap.tasks[state.selected];
    if (action.type === "quit") {
      restore();
      finish();
      return;
    }
    if (!task) return;
    try {
      if (action.type === "open") {
        openInEditor(task.workdir);
        flash(`Opened ${task.workdir} in VS Code (agents keep running).`);
      } else if (action.type === "stop") {
        if (!task.liveSession) return flash("No headless agent is running on this task.");
        requestStop(root, task.liveSession.agentId, task.liveSession.sessionId);
        flash(`Asked ${task.liveSession.agentId} to stop; the task will be handed off.`);
      } else if (action.type === "send") {
        if (!task.liveSession) return flash("No headless agent is running on this task to message.");
        sendToSession(root, task.liveSession.agentId, task.liveSession.sessionId, action.text);
        state.view = "live";
        flash(`Sent to ${task.liveSession.agentId}; it gets the message as its next turn.`);
      }
    } catch (error) {
      flash(`Error: ${(error as Error).message}`);
    }
  };

  input.on("data", (chunk: string) => {
    for (const key of parseInput(chunk)) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
      if (mouse) {
        const [, b, x, y, kind] = mouse;
        if (kind !== "M" || !frame) continue;
        const col = Number(x);
        const row = Number(y);
        if (b === "64") state.scroll = Math.max(0, state.scroll - 3);
        else if (b === "65") state.scroll += 3;
        else if (b === "0" && col <= frame.listWidth && frame.listRows.has(row)) {
          state.selected = frame.listRows.get(row)!;
          state.scroll = 0;
        } else if (b === "0" && row === frame.tabRow) {
          const tab = frame.tabs.find((t) => col >= t.from && col <= t.to);
          if (tab) {
            state.view = tab.view;
            state.scroll = 0;
          }
        }
        continue;
      }
      act(handleKey(state, key, snap.tasks.length));
    }
    draw();
  });

  draw();
  await done;
}
