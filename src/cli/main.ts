#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findOnPath } from "../adapters/process.js";
import { BUILTIN_AGENTS, builtinAdapter, customAdapter } from "../adapters/registry.js";
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
import { brainDir, findRoot } from "../core/paths.js";
import { RULES_TARGETS, writeRules } from "../core/rules.js";
import { getProject, getTask, initStore, listSessions, listTasks } from "../core/store.js";
import type { AgentRef } from "../core/state.js";

const USAGE = `
AgentBrain 0.3 — move coding tasks between AI agents without losing state

Setup
  agentbrain init                         Create .agentbrain/ in the current directory
  agentbrain rules [--only <ids>]         Write AgentBrain instructions for IDE/terminal agents
                                          (${RULES_TARGETS.map((t) => t.id).join(", ")})

Tasks
  agentbrain task create <objective>      Create a task and make it active
  agentbrain task list
  agentbrain task use <task-id>           Make a task active
  agentbrain task update [--task <id>] [--status <s>] [--done <x>]... [--todo <x>]...
        [--decision <x>]... [--failure <x>]... [--fixed <x|n>]... [--blocker <x>]... [--unblock <x|n>]...
        [--next <action>] [--agent <id>] [--session <id>]
  agentbrain status

Switching agents
  agentbrain run <agent> [task-id]        Launch a terminal agent on the task; auto-handoff on exit
  agentbrain run [task-id] --agent <id> -- <command> [args...]
                                          Launch any other agent ({prompt}, {prompt_file} expand)
  agentbrain checkpoint [task-id] [--reason <text>]
                                          Snapshot state; task keeps running
  agentbrain handoff [task-id] [--agent <id>] [--session <id>] [--reason <text>]
                                          Snapshot state and mark the task ready for another agent
  agentbrain resume [task-id] [--agent <id>]
                                          Print the continuation brief; --agent takes over the task
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

/** Agent identity from flags, falling back to the environment `agentbrain run` sets. */
function agentFromFlags(): AgentRef | undefined {
  if (flags.agent) return { id: flags.agent, sessionId: flags.session ?? `s-${Date.now()}` };
  if (flags.session) throw new Error("--session requires --agent.");
  const envAgent = process.env.AGENTBRAIN_AGENT;
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
}

function update(): void {
  const cwd = root();
  const task = updateTask(cwd, resolveTaskId(cwd, flags.task), {
    status: flags.status,
    done: flags.done,
    todo: flags.todo,
    decisions: flags.decision,
    failures: flags.failure,
    blockers: flags.blocker,
    unblock: flags.unblock,
    fixed: flags.fixed,
    next: flags.next,
    agent: flags.agent || process.env.AGENTBRAIN_AGENT ? agentFromFlags() : undefined,
  });
  console.log(`✓ Updated ${task.id} (${task.status})`);
}

function snapshot(kind: "checkpoint" | "handoff", id?: string): void {
  const cwd = root();
  const result = writeCheckpoint(cwd, resolveTaskId(cwd, id), {
    agent: agentFromFlags(),
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
  const taskId = resolveTaskId(cwd, id);
  // Taking over is opt-in: without --agent, resume only prints the brief.
  const agent = flags.agent ? agentFromFlags() : undefined;
  if (agent?.sessionId) takeOver(cwd, taskId, { id: agent.id, sessionId: agent.sessionId });
  console.log(buildPrompt(cwd, taskId, cliCommand()));
}

async function run(agentName: string | undefined, taskArg: string | undefined): Promise<void> {
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

  const taskId = resolveTaskId(cwd, taskArg);
  const previous = getTask(cwd, taskId).agent;
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
    cwd,
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

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = positionals;
  if (flags.help || !command) usage(flags.help ? 0 : 1);

  if (command === "init") {
    initStore(process.cwd());
    console.log("✓ AgentBrain initialized");
    console.log(`  ${brainDir(process.cwd())}`);
    console.log('\nNext: agentbrain task create "<objective>"   then   agentbrain rules');
  } else if (command === "status") {
    status();
  } else if (command === "task" && subcommand === "create") {
    const task = createTask(root(), rest.join(" "));
    console.log(`✓ Created ${task.id}`);
    console.log(`  ${task.objective}`);
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
  } else if (command === "run") {
    // `run <agent> [task]`, or `run [task] -- <command>` for a custom agent.
    if (passthrough.length) await run(undefined, subcommand);
    else await run(subcommand, rest[0]);
  } else if (command === "agents") {
    agents();
  } else if (command === "rules") {
    rules();
  } else {
    usage();
  }
}

main().catch(fail);
