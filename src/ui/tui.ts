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

export type View = "overview" | "changes" | "live" | "timeline" | "route";
export const VIEWS: View[] = ["overview", "changes", "live", "timeline", "route"];

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
const c = (code: string, text: string) => `${ESC}${code}m${text}${ESC}0m`;
const dim = (t: string) => c("2", t);
const bold = (t: string) => c("1", t);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
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
  return `${out}${ESC}0m${" ".repeat(Math.max(0, width - visible))}`;
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

const STATUS_COLOR: Record<string, string> = {
  running: "32",
  handoff: "34",
  review: "35",
  done: "90",
  blocked: "31",
  failed: "31",
  idle: "37",
  checkpoint: "36",
};

function dot(task: LiveTask): string {
  if (task.warning) return c("33", "●");
  return c(STATUS_COLOR[task.status] ?? "37", "●");
}

function ago(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
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
        `${c(STATUS_COLOR[task.status] ?? "37", task.status)}  ${dim("agent")} ${task.agent ?? "none"}  ${dim("id")} ${task.id}`,
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
  }
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

  const header = fit(` ${bold("AgentBrain")}  ${dim(snap.root)}  ${tasks.length} task(s), ${live} agent(s) running headless`, width);
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
  if (!tasks.length) list.push(fit(dim(" No tasks. agentbrain task create \"...\""), listWidth));

  // Right: details for the selected task.
  const body = selected ? detailLines(root, selected, state.view, detailWidth - 1) : [dim("Nothing selected.")];
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
        dim("↑↓ select · 1-5/←→ view · PgUp/PgDn scroll · o open in VS Code · m message · s stop · d show done · q quit");
  lines.push(fit(` ${footer}`, width));
  return { lines, listRows, tabs, tabRow: 2, listWidth };
}

function renderNarrow(root: string, snap: Snapshot, state: TuiState, width: number, height: number, now: Date): Frame {
  const tasks = snap.tasks;
  const selected = tasks[Math.min(state.selected, tasks.length - 1)];
  const lines: string[] = [fit(` ${bold("AgentBrain")} ${dim(`${tasks.length} task(s)`)}`, width)];
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

  const body = selected ? detailLines(root, selected, state.view, width - 1) : [];
  const bodyHeight = height - lines.length - 1;
  const scroll = Math.max(0, Math.min(state.scroll, Math.max(0, body.length - bodyHeight)));
  for (let r = 0; r < bodyHeight; r++) lines.push(fit(` ${body[scroll + r] ?? ""}`, width));
  const footer = state.input !== null ? `${c("7", " msg ")} ${state.input}█` : state.flash || dim("↑↓ 1-5 o open m msg s stop q quit");
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
      if (/^[1-5]$/.test(key)) {
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
