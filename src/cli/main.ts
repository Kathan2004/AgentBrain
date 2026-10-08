#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findOnPath } from "../adapters/process.js";
import { ACP_AGENTS, BUILTIN_AGENTS, acpAgent, builtinAdapter, customAdapter } from "../adapters/registry.js";
import { TOOL_KINDS, type ToolKind } from "../adapters/acp.js";
import { requestStop, runHeadless, sendToSession, sessionControl } from "../core/headless.js";
import { routeTask } from "../core/routing.js";
import { addToQueue, readQueue, removeFromQueue, shiftQueue, waitUntilSettled } from "../core/queue.js";
import { runTui } from "../ui/tui.js";
import {
  buildPrompt,
  closeSession,
  createTask,
  latestCheckpoint,
  resolveTaskId,
  takeOver,
  updateTask,
  useTask,
  writeCheckpoint,
} from "../core/actions.js";
import { CONNECT_TARGETS, connectAgents } from "../core/connect.js";
import { runDoctor } from "../core/doctor.js";
import { remainingFeedback, runMcpServer } from "../mcp/server.js";
import { installPostCommitHook, postCommit, uninstallPostCommitHook } from "../core/githooks.js";
import { brainDir, findRoot } from "../core/paths.js";
import { RULES_TARGETS, writeRules } from "../core/rules.js";
import { findSession, getProject, getTask, initStore, listSessions, listTasks, sessionAlive } from "../core/store.js";
import type { AgentRef } from "../core/state.js";
import { describeActivity, taskActivity } from "../core/stall.js";
import { addWorktree, mergeWorktree, pruneWorktrees, removeWorktree, taskWorkdir } from "../core/worktree.js";
import { taskTimeline } from "../core/timeline.js";
import { pruneTask } from "../core/prune.js";
import { exportTask } from "../core/export.js";
import { startUiServer } from "../ui/server.js";

const USAGE = `
AgentBrain 0.10 — move coding tasks between AI agents without losing state

Live view
  agentbrain                              Every task and agent, live (keyboard and mouse)

Setup
  agentbrain init                         Create .agentbrain/ in the current directory
  agentbrain rules [--only <ids>]         Write AgentBrain instructions for IDE/terminal agents
                                          (${RULES_TARGETS.map((t) => t.id).join(", ")})
  agentbrain connect [--only <ids>]       Give every agent live AgentBrain state via MCP
                                          (${CONNECT_TARGETS.map((t) => t.id).join(", ")}) + rules + Git hook
  agentbrain doctor                         Check setup and print fixes for anything missing
  agentbrain mcp [--root <dir>]           Run the MCP server (started by agents, not by hand)
  agentbrain hooks install                 Install the automatic post-commit checkpoint hook
  agentbrain hooks uninstall               Remove the automatic post-commit checkpoint hook

Tasks
  agentbrain task create <objective>      Create a task and make it active
  agentbrain task list
  agentbrain task create <objective> --worktree
                                          Same, in its own Git worktree (parallel agents never collide)
  agentbrain task use <task-id>           Make a task active
  agentbrain worktree add [task-id]       Give a task its own worktree (.agentbrain/worktrees/<id>)
  agentbrain worktree remove [task-id] [--force]
                                          Remove it; the agentbrain/<id> branch is kept
  agentbrain worktree merge [task-id]     Merge its branch into the current branch, then remove it
  agentbrain worktree prune [--branches] [--dry-run]
                                          Remove worktrees (and merged branches) of finished tasks
  agentbrain worktree list
  agentbrain task update [--task <id>] [--status <s>] [--done <x>]... [--todo <x>]...
        [--decision <x>]... [--failure <x>]... [--fixed <x|n>]... [--blocker <x>]... [--unblock <x|n>]...
        [--next <action>] [--agent <id>] [--session <id>]
  agentbrain status

Switching agents
  agentbrain ui [--port N]                  Open the local live task dashboard
  agentbrain export [task-id] [--out <file>]
                                          Export a portable Markdown brief and history
  agentbrain run <agent> [task-id]        Launch a terminal agent on the task; auto-handoff on exit
  agentbrain run vscode [task-id] --here  Send the task to the VS Code chat you already have open (no new window)
  agentbrain run [task-id] --agent <id> -- <command> [args...]
                                          Launch any other agent ({prompt}, {prompt_file} expand)
  agentbrain run <agent> [task-id] --headless [--allow <kinds>] [--max-turns N] [--timeout <min>]
                                          Run an ACP agent with no UI in the task's worktree
                                          (agents: ${ACP_AGENTS.map((a) => a.id).join(", ")}; default allow: read,edit,search,think)
  agentbrain route [task-id] [--run]      Suggest which agent should take the task, with reasons;
                                          --run launches the top suggestion
  agentbrain run <agent> [task-id] --headless --detach [--linger <min>]
                                          Same, in the background; --linger keeps the agent for follow-ups
  agentbrain queue add <task-id>...       Line up tasks for one agent
  agentbrain queue list | remove <task-id>...
  agentbrain queue run <agent> [--here]   Hand queued tasks to the agent one after another
  agentbrain attach <session-id>          Watch a headless agent live and send it messages
  agentbrain stop <session-id>            Stop a headless agent; the task is handed off
  agentbrain checkpoint [task-id] [--reason <text>]
                                          Snapshot state; task keeps running
  agentbrain handoff [task-id] [--agent <id>] [--session <id>] [--reason <text>]
                                          Snapshot state and mark the task ready for another agent
  agentbrain resume [task-id] [--agent <id>]
                                          Print the continuation brief; --agent takes over the task
  agentbrain log [task-id]                 Show the task timeline
  agentbrain prune [task-id] [--keep N] [--all] [--dry-run]
                                          Remove old checkpoint history
  agentbrain agents                       Show supported agents and recorded sessions

Agents: ${BUILTIN_AGENTS.map((a) => a.id).join(", ")}
Inside \`agentbrain run\`, AGENTBRAIN_AGENT/AGENTBRAIN_SESSION identify the agent automatically.
`;

function usage(code = 1): never {
  console.log(USAGE);
  process.exit(code);
}

function fail(error: unknown): never {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Everything after `--` is a command to launch, not AgentBrain arguments.
const argv = process.argv.slice(2);
const dashDash = argv.indexOf("--");
const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);

function parseCli() {
  try {
    return parseArgs({
      args: dashDash === -1 ? argv : argv.slice(0, dashDash),
      allowPositionals: true,
      options: {
        task: { type: "string" },
        status: { type: "string" },
        done: { type: "string", multiple: true },
        todo: { type: "string", multiple: true },
        decision: { type: "string", multiple: true },
        failure: { type: "string", multiple: true },
        blocker: { type: "string", multiple: true },
        unblock: { type: "string", multiple: true },
        fixed: { type: "string", multiple: true },
        next: { type: "string" },
        agent: { type: "string" },
        session: { type: "string" },
        reason: { type: "string" },
        only: { type: "string" },
        cli: { type: "string" },
        root: { type: "string" },
        out: { type: "string" },
        keep: { type: "string" },
        all: { type: "boolean" },
        "dry-run": { type: "boolean" },
        worktree: { type: "boolean" },
        headless: { type: "boolean" },
        run: { type: "boolean" },
        allow: { type: "string" },
        "max-turns": { type: "string" },
        timeout: { type: "string" },
        "in-place": { type: "boolean" },
        detach: { type: "boolean" },
        here: { type: "boolean" },
        branches: { type: "boolean" },
        poll: { type: "string" },
        linger: { type: "string" },
        port: { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail(error);
  }
}

const { values: flags, positionals } = parseCli();

/** Project root: nearest ancestor with `.agentbrain/`, so commands work from subdirectories. */
function root(): string {
  const found = findRoot(process.cwd());
  if (!found) throw new Error("AgentBrain is not initialized. Run: agentbrain init");
  return found;
}

/** Agent id the caller claims, for picking that agent's own task. */
function callerId(): string | undefined {
  return flags.agent ?? (process.env.AGENTBRAIN_AGENT || undefined);
}

/** Agent identity from flags, falling back to the environment `agentbrain run` sets. */
function agentFromFlags(targetTask?: string): AgentRef | undefined {
  if (flags.agent) return { id: flags.agent, sessionId: flags.session ?? `s-${Date.now()}` };
  if (flags.session) throw new Error("--session requires --agent.");
  const envAgent = process.env.AGENTBRAIN_AGENT;
  // An identity inherited from a long-lived app (e.g. VS Code launched by an
  // earlier `agentbrain run`) belongs to that run's task; don't apply it elsewhere.
  const envTask = process.env.AGENTBRAIN_TASK;
  if (envAgent && envTask && targetTask && envTask !== targetTask) return undefined;
  if (envAgent) return { id: envAgent, sessionId: process.env.AGENTBRAIN_SESSION ?? `s-${Date.now()}` };
  return undefined;
}

/** How agents should invoke AgentBrain: the bare command if it's on PATH, else this script. */
function cliCommand(): string {
  if (flags.cli) return flags.cli;
  if (findOnPath("agentbrain")) return "agentbrain";
  return `node ${JSON.stringify(fs.realpathSync(process.argv[1]))}`;
}

function bullets(items: string[] | undefined): string {
  return items?.length ? items.map((x) => `  - ${x}`).join("\n") : "  (none)";
}

function describeAgent(agent?: AgentRef): string {
  if (!agent) return "none";
  return agent.sessionId ? `${agent.id} (${agent.sessionId})` : agent.id;
}

function status(): void {
  const cwd = root();
  const project = getProject(cwd);
  const tasks = listTasks(cwd);

  console.log("AgentBrain status\n");
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Active: ${project.activeTaskId ?? "none"}`);
  if (!project.activeTaskId) return;

  const task = getTask(cwd, project.activeTaskId);
  const last = latestCheckpoint(cwd, task.id);
  console.log(`\n${task.id} — ${task.objective}`);
  console.log(`Status: ${task.status}`);
  console.log(`Agent: ${describeAgent(task.agent)}`);
  if (task.worktree) console.log(`Worktree: ${task.worktree.path} (${task.worktree.branch})`);
  console.log(`Completed:\n${bullets(task.completed)}`);
  console.log(`Remaining:\n${task.remaining.length ? task.remaining.map((x, i) => `  ${i + 1}. ${x}`).join("\n") : "  (none)"}`);
  if (task.blockers?.length) console.log(`Blockers:\n${bullets(task.blockers)}`);
  if (task.failures.length) {
    console.log(`Known failures:\n${task.failures.map((x, i) => `  ${i + 1}. ${x}`).join("\n")}`);
  }
  if (task.nextAction) console.log(`Next: ${task.nextAction}`);
  if (last) {
    console.log(`Last checkpoint: ${last.checkpointId} (${last.status}, ${last.timestamp}${last.stopReason ? `, ${last.stopReason}` : ""})`);
  }
  const warning = describeActivity(taskActivity(cwd, task, project.stallMinutes));
  if (warning) {
    console.log(`\n⚠ ${warning}`);
    console.log("  Check on it, or take over: agentbrain run <agent>   or   agentbrain resume --agent <id>");
  }
  // Other running tasks can stall too.
  for (const other of tasks.filter((t) => t.id !== task.id && t.status === "running")) {
    const otherWarning = describeActivity(taskActivity(cwd, other, project.stallMinutes));
    if (otherWarning) console.log(`\n⚠ ${other.id}: ${otherWarning}`);
  }
}

function update(): void {
  const cwd = root();
  const taskId = resolveTaskId(cwd, flags.task, callerId(), process.cwd());
  const task = updateTask(cwd, taskId, {
    status: flags.status,
    done: flags.done,
    todo: flags.todo,
    decisions: flags.decision,
    failures: flags.failure,
    blockers: flags.blocker,
    unblock: flags.unblock,
    fixed: flags.fixed,
    next: flags.next,
    agent: flags.agent || process.env.AGENTBRAIN_AGENT ? agentFromFlags(taskId) : undefined,
  });
  console.log(`✓ Updated ${task.id} (${task.status})${remainingFeedback(task.status, task.remaining).replaceAll("agentbrain_update with done set to their numbers", "agentbrain task update --done <n>").replaceAll("done: [numbers]", "--done <n>")}`);
}

function snapshot(kind: "checkpoint" | "handoff", id?: string): void {
  const cwd = root();
  const taskId = resolveTaskId(cwd, id, callerId(), process.cwd());
  const result = writeCheckpoint(cwd, taskId, {
    agent: agentFromFlags(taskId),
    reason: flags.reason,
    status: kind,
  });
  console.log(`✓ ${kind === "handoff" ? "Handoff" : "Checkpoint"} ${result.checkpoint.checkpointId} for ${result.task.id}`);
  console.log(`  ${result.jsonFile}`);
  console.log(`  ${result.markdownFile}`);
  if (result.checkpoint.git.dirty) {
    console.log(`  Note: ${result.checkpoint.git.changedFiles.length} uncommitted file(s) recorded; nothing was committed.`);
  }
  if (kind === "handoff") console.log("\nNext agent: agentbrain run <agent>   or   agentbrain resume --agent <id>");
}

function resume(id?: string): void {
  const cwd = root();
  const taskId = resolveTaskId(cwd, id, undefined, process.cwd());
  // Taking over is opt-in: without --agent, resume only prints the brief.
  const agent = flags.agent ? agentFromFlags() : undefined;
  if (agent?.sessionId) takeOver(cwd, taskId, { id: agent.id, sessionId: agent.sessionId });
  console.log(buildPrompt(cwd, taskId, cliCommand()));
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`--${name} must be a whole number greater than 0.`);
  return Number(value);
}

function positiveNumber(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a number greater than 0.`);
  return n;
}

/** `agentbrain run <agent> [task] --headless`: drive an ACP agent with no UI. */
async function runHeadlessCli(agentName: string | undefined, taskArg: string | undefined): Promise<void> {
  const cwd = root();
  const def = passthrough.length
    ? { id: flags.agent ?? path.basename(passthrough[0]), name: passthrough[0], command: passthrough[0], args: passthrough.slice(1) }
    : agentName
      ? acpAgent(agentName)
      : null;
  if (!def) {
    throw new Error(
      `${agentName ? `"${agentName}" has no ACP adapter. ` : ""}Headless agents: ${ACP_AGENTS.map((a) => a.id).join(", ")}. ` +
        "For any other ACP agent: agentbrain run [task] --headless --agent <id> -- <command> [args...]",
    );
  }
  if (!findOnPath(def.command)) throw new Error(`"${def.command}" was not found on PATH. Install ${def.name} first.`);

  const allowed = flags.allow
    ? flags.allow.split(",").map((k) => k.trim()).filter(Boolean)
    : undefined;
  const unknown = (allowed ?? []).filter((k) => !(TOOL_KINDS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`Unknown tool kind(s): ${unknown.join(", ")}. Use: ${TOOL_KINDS.join(", ")}`);

  const taskId = resolveTaskId(cwd, taskArg ?? flags.task, undefined, process.cwd());
  const onPath = findOnPath("agentbrain") !== null;

  if (flags.detach) {
    // Re-run this command in the background with a known session id, output to a file.
    const sessionId = flags.session ?? `acp-${Date.now()}`;
    const control = sessionControl(cwd, def.id, sessionId);
    fs.mkdirSync(path.dirname(control.output), { recursive: true });
    const out = fs.openSync(control.output, "a");
    // Pin task and session so the background run can't drift to whatever becomes active.
    const args = process.argv.slice(2).filter((a) => a !== "--detach");
    const dd = args.indexOf("--");
    const pin = ["--task", taskId, "--session", sessionId];
    const childArgs = dd === -1 ? [...args, ...pin] : [...args.slice(0, dd), ...pin, ...args.slice(dd)];
    const child = spawn(process.execPath, [fs.realpathSync(process.argv[1]), ...childArgs], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, AGENTBRAIN_AGENT: "", AGENTBRAIN_SESSION: "" },
    });
    child.unref();
    console.log(`▶ ${def.name} is working on ${taskId} in the background (session ${sessionId}).`);
    console.log(`  watch and talk to it:  agentbrain attach ${sessionId}`);
    console.log(`  everything at a glance: agentbrain`);
    console.log(`  stop it:               agentbrain stop ${sessionId}`);
    return;
  }

  console.error(`▶ ${def.name} → ${taskId} (headless)`);
  const result = await runHeadless(cwd, taskId, def, {
    cli: onPath ? { command: "agentbrain", args: [] } : { command: process.execPath, args: [fs.realpathSync(process.argv[1])] },
    allowed: allowed as ToolKind[] | undefined,
    maxTurns: positiveInt("max-turns", flags["max-turns"], 3),
    timeoutMinutes: flags.timeout === undefined ? undefined : positiveNumber("timeout", flags.timeout),
    inPlace: flags["in-place"],
    sessionId: flags.session,
    lingerMinutes: flags.linger === undefined ? undefined : positiveNumber("linger", flags.linger),
    onEvent: (event) => {
      if (event.kind === "tool" || event.kind === "permission" || event.kind === "fs") console.error(`  ${event.kind}: ${event.text}`);
    },
  });
  console.error(`\n✓ ${result.turns} turn(s), stop reason: ${result.stopReason}; task is ${result.status}`);
  console.error(`  worktree:   ${result.workdir}`);
  console.error(`  transcript: ${result.transcript}`);
  if (result.status !== "done" && result.status !== "review") process.exitCode = 1;
}

/**
 * `agentbrain queue run <agent> [--here]`: hand queued tasks to one agent, one
 * after another. Each task is launched like `agentbrain run`; detached agents
 * (VS Code) are watched until the task settles before the next is sent.
 */
async function queueRun(agentName: string | undefined): Promise<void> {
  const cwd = root();
  if (!agentName && !passthrough.length) throw new Error("Usage: agentbrain queue run <agent> [--here] [--headless]");
  const pollMs = flags.poll === undefined ? 3000 : positiveNumber("poll", flags.poll) * 1000;
  for (let taskId = shiftQueue(cwd); taskId; taskId = shiftQueue(cwd)) {
    const task = getTask(cwd, taskId);
    console.log(`\n▶ queue: ${taskId} — ${task.objective} (${readQueue(cwd).length} more after this)`);
    await run(agentName, taskId);
    const status = await waitUntilSettled(cwd, taskId, pollMs);
    console.log(`✓ queue: ${taskId} is ${status}`);
    if (status === "blocked" || status === "failed") {
      console.log("  Stopping the queue: this task needs you. Resume with: agentbrain queue run " + (agentName ?? ""));
      return;
    }
  }
  console.log("\nQueue is empty.");
}

async function run(agentName: string | undefined, taskArg: string | undefined): Promise<void> {
  if (flags.headless) return runHeadlessCli(agentName, taskArg);
  const cwd = root();
  const adapter = passthrough.length
    ? customAdapter(passthrough, flags.agent)
    : agentName
      ? builtinAdapter(agentName)
      : null;
  if (!adapter) {
    throw new Error(
      agentName
        ? `Unknown agent "${agentName}". Built in: ${BUILTIN_AGENTS.map((a) => a.id).join(", ")}. ` +
            "For anything else: agentbrain run --agent <id> -- <command> [args...]"
        : "Usage: agentbrain run <agent> [task-id]",
    );
  }
  if (!adapter.available()) {
    throw new Error(`"${adapter.definition.command}" was not found on PATH. Install ${adapter.definition.name} first.`);
  }

  const taskId = resolveTaskId(cwd, taskArg, undefined, process.cwd());
  const previous = getTask(cwd, taskId).agent;
  const workdir = taskWorkdir(cwd, getTask(cwd, taskId));
  const agent = { id: adapter.id, sessionId: flags.session ?? `s-${Date.now()}` };
  takeOver(cwd, taskId, agent);

  const prompt = buildPrompt(cwd, taskId, cliCommand());
  const promptFile = path.join(brainDir(cwd), "agents", agent.id, "sessions", `${agent.sessionId}.prompt.md`);
  fs.writeFileSync(promptFile, prompt, "utf8");

  console.error(
    `▶ ${adapter.definition.name} → ${taskId}` +
      (previous && previous.id !== agent.id ? ` (taking over from ${previous.id})` : "") +
      `\n  session ${agent.sessionId}` +
      (adapter.definition.detached ? "\n" : "; AgentBrain will checkpoint when it exits.\n"),
  );

  // Ctrl-C belongs to the agent. AgentBrain stays alive to checkpoint afterwards.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  const session = await adapter.resume({
    cwd: workdir,
    here: flags.here,
    taskId,
    objective: getTask(cwd, taskId).objective,
    handoff: prompt,
    promptFile,
    env: {
      AGENTBRAIN_AGENT: agent.id,
      AGENTBRAIN_SESSION: agent.sessionId,
      AGENTBRAIN_TASK: taskId,
      AGENTBRAIN_ROOT: cwd,
      AGENTBRAIN_PROMPT_FILE: promptFile,
    },
  });
  const forward = () => void adapter.stop(session);
  process.on("SIGTERM", forward);
  process.on("SIGHUP", forward);

  let reason: string;
  let exitCode = 1;
  try {
    const exit = await session.exited!;
    exitCode = exit.code ?? 1;
    reason = exit.signal ? `${agent.id} stopped by ${exit.signal}` : `${agent.id} exited with code ${exit.code}`;
  } catch (error) {
    reason = `${agent.id} failed to start: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", forward);
    process.off("SIGHUP", forward);
  }

  if (adapter.definition.detached && exitCode === 0) {
    console.error(
      `\n✓ ${adapter.definition.name} is open and owns the task (session ${agent.sessionId}).` +
        "\n  It records progress and hands off through AgentBrain; check with: agentbrain status",
    );
    return;
  }

  // If the agent didn't hand off (or finish) itself — usage limit, crash, closed
  // terminal — record where it got to so the next agent can continue.
  const task = getTask(cwd, taskId);
  if (task.status === "running" && task.agent?.sessionId === agent.sessionId) {
    const result = writeCheckpoint(cwd, taskId, { agent, reason, status: "handoff" });
    console.error(`\n✓ Auto-handoff ${result.checkpoint.checkpointId}: ${reason}`);
  } else {
    closeSession(cwd, agent, reason);
    console.error(`\n✓ Session ended; task is ${task.status}.`);
  }
  if (task.status !== "done" && task.status !== "review") {
    console.error("  Continue with: agentbrain run <agent>   (or agentbrain resume --agent <id> in an IDE agent)");
  }
  process.exitCode = exitCode;
}

async function route(id?: string): Promise<void> {
  const cwd = root();
  const taskId = resolveTaskId(cwd, id, undefined, process.cwd());
  const task = getTask(cwd, taskId);
  const ranked = routeTask(cwd, taskId);
  console.log(`Who should take ${task.id} — ${task.objective} (${task.status})?\n`);
  const available = ranked.filter((c) => c.available);
  available.forEach((c, i) => {
    console.log(`${i + 1}. ${c.name} [${c.mode}]  score ${c.score}`);
    for (const reason of c.reasons) console.log(`     - ${reason}`);
    console.log(`     $ ${c.command}`);
  });
  if (!available.length) console.log("No supported agent is installed. Run `agentbrain agents` to see options.");
  const missing = ranked.filter((c) => !c.available).map((c) => (c.mode === "headless" ? `${c.id} (headless)` : c.id));
  if (missing.length) console.log(`\nNot installed: ${[...new Set(missing)].join(", ")}`);

  if (flags.run) {
    const top = available[0];
    if (!top) throw new Error("Nothing to run.");
    if (top.score <= -100) throw new Error(`Top suggestion ${top.id} is likely unavailable (${top.reasons.join("; ")}). Pick one yourself.`);
    console.log(`\nLaunching ${top.name}...`);
    flags.headless = top.mode === "headless";
    await run(top.id, taskId);
  }
}

/** `agentbrain attach <session>`: watch a headless agent live and talk to it, without restarting it. */
async function attach(sessionId?: string): Promise<void> {
  const cwd = root();
  if (!sessionId) throw new Error("Usage: agentbrain attach <session-id>   (see `agentbrain` or `agentbrain agents`)");
  const session = findSession(cwd, sessionId);
  if (!session?.transcript) throw new Error(`No headless session ${sessionId}.`);
  const control = sessionControl(cwd, session.agentId, sessionId);
  console.log(`Attached to ${session.agentId} on ${session.taskId}. Type a message and press Enter to send it as the agent's next turn.`);
  console.log("/stop stops the run; Ctrl-C detaches and leaves it running.\n");

  let offset = 0;
  const pump = () => {
    if (!fs.existsSync(control.transcript)) return;
    const text = fs.readFileSync(control.transcript, "utf8");
    if (text.length > offset) process.stdout.write(text.slice(offset));
    offset = text.length;
  };
  pump();
  const timer = setInterval(() => {
    pump();
    const latest = findSession(cwd, sessionId);
    if (latest && !sessionAlive(latest)) {
      pump();
      console.log(`\n— session ended${latest.stopReason ? `: ${latest.stopReason}` : ""}`);
      clearInterval(timer);
      process.exit(0);
    }
  }, 500);

  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === "/stop") {
      requestStop(cwd, session.agentId, sessionId);
      console.log("— stop requested");
    } else {
      sendToSession(cwd, session.agentId, sessionId, text);
      console.log("— sent; the agent gets it as its next turn");
    }
  });
  rl.on("close", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

function agents(): void {
  console.log("Terminal agents (agentbrain run <id>):");
  for (const def of BUILTIN_AGENTS) {
    const found = builtinAdapter(def.id)!.resolve();
    console.log(`  ${found ? "✓" : "✗"} ${def.id.padEnd(12)} ${def.name} (${found ?? `${def.command}, not installed`})`);
  }
  console.log("\nIDE agents (Cursor, Copilot in VS Code, Windsurf, ...):");
  console.log("  Run `agentbrain rules`, then ask the agent to continue the AgentBrain task.");

  const cwd = findRoot(process.cwd());
  if (!cwd) return;
  const sessions = listSessions(cwd);
  console.log(`\nSessions (${sessions.length}):`);
  for (const s of sessions) {
    const state = s.endedAt ? `ended ${s.endedAt}${s.stopReason ? ` — ${s.stopReason}` : ""}` : "active";
    console.log(`  ${s.agentId}/${s.sessionId}  ${s.taskId}  started ${s.startedAt}, ${state}`);
  }
}

function localTime(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function log(id?: string): void {
  const cwd = root();
  const taskId = resolveTaskId(cwd, id);
  for (const event of taskTimeline(cwd, taskId)) {
    console.log(`${localTime(event.timestamp)} ${event.agent.padEnd(12)} ${event.event.padEnd(10)} ${event.reason}`);
  }
}

function exportMarkdown(id?: string): void {
  const cwd = root();
  const taskId = resolveTaskId(cwd, id);
  const markdown = exportTask(cwd, taskId);
  if (flags.out) {
    const file = path.resolve(process.cwd(), flags.out);
    fs.writeFileSync(file, markdown, "utf8");
    console.log(`✓ Exported ${taskId} to ${file}`);
  } else {
    process.stdout.write(markdown);
  }
}

function prune(id?: string): void {
  const cwd = root();
  if (flags.all && id) throw new Error("Use either a task id or --all, not both.");
  const keepText = flags.keep ?? "20";
  if (!/^\d+$/.test(keepText)) throw new Error("--keep must be a whole number greater than 0.");
  const keep = Number.parseInt(keepText, 10);
  if (keep < 1) throw new Error("--keep must be a whole number greater than 0.");
  const taskIds = flags.all ? listTasks(cwd).map((task) => task.id) : [resolveTaskId(cwd, id)];
  for (const taskId of taskIds) {
    const result = pruneTask(cwd, taskId, keep, flags["dry-run"]);
    const action = flags["dry-run"] ? "would delete" : "deleted";
    console.log(`${taskId}: ${action} ${result.deleted.length} checkpoint${result.deleted.length === 1 ? "" : "s"} (kept ${result.kept.length})`);
  }
}

function rules(): void {
  const cwd = root();
  const only = flags.only?.split(",").map((x) => x.trim()).filter(Boolean);
  const cli = cliCommand();
  for (const { file, action } of writeRules(cwd, cli, only)) console.log(`✓ ${action} ${file}`);
  if (cli !== "agentbrain") {
    console.log(`\nNote: \`agentbrain\` is not on PATH, so the rules call ${cli}.`);
    console.log("Run `npm link` in the AgentBrain repo, then `agentbrain rules` again for portable rules.");
  }
}

function hooks(action: "install" | "uninstall"): void {
  const file = action === "install" ? installPostCommitHook(root()) : uninstallPostCommitHook(root());
  console.log(`✓ ${action === "install" ? "Installed" : "Uninstalled"} Git hook`);
  console.log(`  ${file}`);
}

async function ui(): Promise<void> {
  const text = flags.port ?? "4747";
  if (!/^\d+$/.test(text)) throw new Error("--port must be a number.");
  const port = Number(text);
  if (port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535.");
  const server = await startUiServer(root(), { port });
  console.log(server.url);
  const close = () => { void server.close().finally(() => process.exit(0)); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise<void>(() => {});
}

function doctor(): void {
  const checks = runDoctor(process.cwd());
  for (const check of checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.name}  ${check.detail}`);
    if (!check.ok && check.fix) console.log(`    fix: ${check.fix}`);
  }
  if (checks.some((check) => !check.ok && ["Node.js", "Git repository", "AgentBrain initialized"].includes(check.name))) {
    process.exitCode = 1;
  }
}

function printWorktree(task: ReturnType<typeof getTask>): void {
  console.log(`✓ Worktree for ${task.id} on branch ${task.worktree!.branch}`);
  console.log(`  ${task.worktree!.path}`);
  console.log(`  Agents launched with \`agentbrain run <agent> ${task.id}\` work there; commands run inside it apply to this task.`);
}

/** MCP config for every agent, plus instruction files and the commit hook. */
function connect(): void {
  const cwd = root();
  const onPath = findOnPath("agentbrain") !== null;
  const command = onPath ? "agentbrain" : process.execPath;
  const args = onPath ? ["mcp"] : [fs.realpathSync(process.argv[1]), "mcp"];
  const only = flags.only?.split(",").map((x) => x.trim()).filter(Boolean);

  console.log("MCP (live state in every new agent session):");
  for (const r of connectAgents(cwd, command, args, only)) {
    console.log(`  ${r.action === "skipped" ? "!" : "✓"} ${r.agent.padEnd(26)} ${r.file} (${r.action})${r.note ? `\n      ${r.note}` : ""}`);
  }
  if (!only?.length) {
    console.log(`  → Codex (user-level config): codex mcp add agentbrain -- ${[command, ...args].join(" ")}`);
    console.log("\nInstruction files (fallback for agents without MCP):");
    for (const { file, action } of writeRules(cwd, cliCommand())) console.log(`  ✓ ${file} (${action})`);
    try {
      console.log(`\nGit hook (checkpoint on every commit):\n  ✓ ${installPostCommitHook(cwd)}`);
    } catch {
      console.log("\nGit hook: skipped (not a Git repository)");
    }
  }
  if (!onPath) console.log("\nNote: `agentbrain` is not on PATH, so configs use absolute paths (not portable).");
  console.log("\nRestart open agent sessions (or reload the VS Code / Cursor window) to pick up the MCP server.");
}

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = positionals;
  if (flags.help) usage(0);
  // Bare `agentbrain` in a terminal opens the live view of every task and agent.
  if (!command) {
    if (!process.stdout.isTTY || !process.stdin.isTTY) usage(1);
    await runTui(root());
    return;
  }

  if (command === "init") {
    initStore(process.cwd());
    console.log("✓ AgentBrain initialized");
    console.log(`  ${brainDir(process.cwd())}`);
    console.log('\nNext: agentbrain task create "<objective>"   then   agentbrain rules');
  } else if (command === "status") {
    status();
  } else if (command === "task" && subcommand === "create") {
    const cwd = root();
    const task = createTask(cwd, rest.join(" "));
    console.log(`✓ Created ${task.id}`);
    console.log(`  ${task.objective}`);
    if (flags.worktree) printWorktree(addWorktree(cwd, task.id));
  } else if (command === "task" && subcommand === "update") {
    update();
  } else if (command === "task" && subcommand === "use") {
    if (!rest[0]) throw new Error("Usage: agentbrain task use <task-id>");
    const task = useTask(root(), rest[0]);
    console.log(`✓ Active task: ${task.id} — ${task.objective}`);
  } else if (command === "task" && subcommand === "list") {
    const cwd = root();
    const active = getProject(cwd).activeTaskId;
    for (const task of listTasks(cwd)) {
      console.log(`${task.id === active ? "*" : " "} ${task.id}\t${task.status}\t${task.objective}`);
    }
  } else if (command === "checkpoint" || command === "handoff") {
    snapshot(command, subcommand);
  } else if (command === "resume") {
    resume(subcommand);
  } else if (command === "log") {
    log(subcommand);
  } else if (command === "export") {
    exportMarkdown(subcommand);
  } else if (command === "prune") {
    prune(subcommand);
  } else if (command === "run") {
    // `run <agent> [task]`, or `run [task] -- <command>` for a custom agent.
    if (passthrough.length) await run(undefined, subcommand);
    else await run(subcommand, rest[0]);
  } else if (command === "attach") {
    await attach(subcommand);
  } else if (command === "stop") {
    const cwd = root();
    const session = subcommand ? findSession(cwd, subcommand) : null;
    if (!session) throw new Error("Usage: agentbrain stop <session-id>");
    requestStop(cwd, session.agentId, session.sessionId);
    console.log(`✓ Asked ${session.agentId} (${session.sessionId}) to stop; it will hand off the task.`);
  } else if (command === "queue" && subcommand === "add") {
    const queue = addToQueue(root(), rest);
    console.log(`✓ Queue: ${queue.join(", ")}`);
  } else if (command === "queue" && subcommand === "remove") {
    console.log(`✓ Queue: ${removeFromQueue(root(), rest).join(", ") || "(empty)"}`);
  } else if (command === "queue" && subcommand === "list") {
    const cwd = root();
    const queue = readQueue(cwd);
    if (!queue.length) console.log("Queue is empty.");
    queue.forEach((id, i) => console.log(`${i + 1}. ${id}\t${getTask(cwd, id).status}\t${getTask(cwd, id).objective}`));
  } else if (command === "queue" && subcommand === "run") {
    await queueRun(rest[0]);
  } else if (command === "route") {
    await route(subcommand);
  } else if (command === "agents") {
    agents();
  } else if (command === "rules") {
    rules();
  } else if (command === "worktree" && subcommand === "add") {
    const cwd = root();
    printWorktree(addWorktree(cwd, resolveTaskId(cwd, rest[0], undefined, process.cwd())));
  } else if (command === "worktree" && subcommand === "remove") {
    const cwd = root();
    const { task, unmerged } = removeWorktree(cwd, resolveTaskId(cwd, rest[0], undefined, process.cwd()), flags.force);
    console.log(`✓ Removed the worktree for ${task.id}; branch agentbrain/${task.id} is kept.`);
    if (unmerged) console.log(`  ${unmerged} commit(s) not merged yet: git merge agentbrain/${task.id}`);
  } else if (command === "worktree" && subcommand === "merge") {
    const cwd = root();
    const { task, merged, conflicts } = mergeWorktree(cwd, resolveTaskId(cwd, rest[0], undefined, process.cwd()));
    if (conflicts.length) {
      console.log(`✗ Merging agentbrain/${task.id} hit conflicts; the merge is left in progress:`);
      for (const file of conflicts) console.log(`  - ${file}`);
      console.log("  Resolve them and commit (or git merge --abort). The worktree is kept.");
      process.exitCode = 1;
    } else {
      console.log(`✓ Merged ${merged} commit(s) from agentbrain/${task.id} and removed its worktree.`);
    }
  } else if (command === "worktree" && subcommand === "prune") {
    const result = pruneWorktrees(root(), { branches: flags.branches, dryRun: flags["dry-run"] });
    const verb = flags["dry-run"] ? "would remove" : "removed";
    console.log(`${verb} ${result.removed.length} worktree(s)${result.removed.length ? `: ${result.removed.join(", ")}` : ""}`);
    if (flags.branches) console.log(`${flags["dry-run"] ? "would delete" : "deleted"} ${result.deletedBranches.length} merged branch(es)`);
    for (const s of result.skipped) console.log(`  kept ${s.taskId}: ${s.reason}`);
  } else if (command === "worktree" && subcommand === "list") {
    const cwd = root();
    for (const task of listTasks(cwd).filter((t) => t.worktree)) {
      console.log(`${task.id}\t${task.status}\t${task.worktree!.branch}\t${task.worktree!.path}`);
    }
  } else if (command === "connect") {
    connect();
  } else if (command === "mcp") {
    await runMcpServer(
      flags.root ?? process.cwd(),
      flags.agent && flags.session ? { id: flags.agent, sessionId: flags.session } : undefined,
    );
  } else if (command === "hooks" && (subcommand === "install" || subcommand === "uninstall")) {
    hooks(subcommand);
  } else if (command === "doctor") {
    doctor();
  } else if (command === "ui") {
    await ui();
  } else if (command === "hook" && subcommand === "post-commit") {
    postCommit(process.cwd());
  } else {
    usage();
  }
}

main().catch(fail);
