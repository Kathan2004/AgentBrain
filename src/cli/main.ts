#!/usr/bin/env node
import fs from "node:fs";
import { parseArgs } from "node:util";
import { getGitState } from "../core/git.js";
import { makeCheckpoint, renderHandoff } from "../core/handoff.js";
import { brainDir, findRoot } from "../core/paths.js";
import {
  getProject,
  getSession,
  getTask,
  initStore,
  latestHandoffFile,
  listTasks,
  saveCheckpoint,
  saveProject,
  saveSession,
  saveTask,
} from "../core/store.js";
import { SCHEMA_VERSION, TASK_STATUSES, isTaskStatus } from "../core/state.js";
import type { AgentRef, TaskState } from "../core/state.js";

const USAGE = `
AgentBrain 0.1

Commands:
  agentbrain init
  agentbrain status
  agentbrain task create <objective>
  agentbrain task list
  agentbrain task update [--task <id>] [--status <status>] [--done <item>]...
                         [--todo <item>]... [--decision <text>]... [--failure <text>]...
                         [--blocker <text>]... [--next <action>] [--agent <id>] [--session <id>]
  agentbrain handoff [task-id] [--agent <id>] [--session <id>] [--reason <text>]
  agentbrain resume [task-id] [--agent <id>] [--session <id>]

Repeatable flags (--done, --todo, ...) may be given multiple times.
--done moves a matching item out of "remaining" when present.
resume --agent marks the task running and records the new agent session.
`;

function usage(): never {
  console.log(USAGE);
  process.exit(1);
}

function parseCli() {
  try {
    return parse();
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const parse = () => parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    task: { type: "string" },
    status: { type: "string" },
    done: { type: "string", multiple: true },
    todo: { type: "string", multiple: true },
    decision: { type: "string", multiple: true },
    failure: { type: "string", multiple: true },
    blocker: { type: "string", multiple: true },
    next: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
    reason: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const { values: flags, positionals } = parseCli();

/** Project root: nearest ancestor with `.agentbrain/`, so commands work from subdirectories. */
function root(): string {
  const found = findRoot(process.cwd());
  if (!found) throw new Error("AgentBrain is not initialized. Run: agentbrain init");
  return found;
}

function resolveTaskId(cwd: string, id?: string): string {
  const taskIdValue = id ?? getProject(cwd).activeTaskId;
  if (!taskIdValue) throw new Error('No active task. Create one with: agentbrain task create "<objective>"');
  return taskIdValue;
}

function agentFromFlags(): AgentRef | undefined {
  if (!flags.agent) {
    if (flags.session) throw new Error("--session requires --agent.");
    return undefined;
  }
  return { id: flags.agent, sessionId: flags.session ?? `s-${Date.now()}` };
}

function bullets(items: string[] | undefined): string {
  return items?.length ? items.map((x) => `  - ${x}`).join("\n") : "  (none)";
}

function createTask(objective: string): void {
  const cwd = root();
  if (!objective.trim()) throw new Error("Task objective cannot be empty.");

  let id = `task-${Date.now()}`;
  for (let n = 2; fs.existsSync(`${brainDir(cwd)}/tasks/${id}`); n++) id = `task-${Date.now()}-${n}`;

  const now = new Date().toISOString();
  const task: TaskState = {
    schemaVersion: SCHEMA_VERSION,
    id,
    objective: objective.trim(),
    status: "idle",
    createdAt: now,
    updatedAt: now,
    completed: [],
    remaining: [objective.trim()],
    decisions: [],
    failures: [],
    blockers: [],
  };

  saveTask(cwd, task);
  const project = getProject(cwd);
  project.activeTaskId = id;
  saveProject(cwd, project);

  console.log(`✓ Created ${id}`);
  console.log(`  ${task.objective}`);
}

function updateTask(): void {
  const cwd = root();
  const task = getTask(cwd, resolveTaskId(cwd, flags.task));

  if (flags.status) {
    if (!isTaskStatus(flags.status)) {
      throw new Error(`Unknown status "${flags.status}". Use one of: ${TASK_STATUSES.join(", ")}`);
    }
    task.status = flags.status;
  }
  for (const item of flags.done ?? []) {
    task.remaining = task.remaining.filter((r) => r !== item);
    if (!task.completed.includes(item)) task.completed.push(item);
  }
  for (const item of flags.todo ?? []) if (!task.remaining.includes(item)) task.remaining.push(item);
  task.decisions.push(...(flags.decision ?? []));
  task.failures.push(...(flags.failure ?? []));
  task.blockers = [...(task.blockers ?? []), ...(flags.blocker ?? [])];
  if (flags.next !== undefined) task.nextAction = flags.next;

  const agent = agentFromFlags();
  if (agent) task.agent = agent;
  // Recording progress implies someone is working on the task.
  if (!flags.status && task.status === "idle") task.status = "running";

  saveTask(cwd, task);
  console.log(`✓ Updated ${task.id} (${task.status})`);
}

function status(): void {
  const cwd = root();
  const project = getProject(cwd);
  const tasks = listTasks(cwd);

  console.log("AgentBrain status\n");
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Active: ${project.activeTaskId ?? "none"}`);

  if (project.activeTaskId) {
    const task = getTask(cwd, project.activeTaskId);
    console.log(`\n${task.id} — ${task.objective}`);
    console.log(`Status: ${task.status}`);
    if (task.agent) console.log(`Agent: ${task.agent.id}${task.agent.sessionId ? ` (${task.agent.sessionId})` : ""}`);
    console.log(`Completed:\n${bullets(task.completed)}`);
    console.log(`Remaining:\n${bullets(task.remaining)}`);
    if (task.blockers?.length) console.log(`Blockers:\n${bullets(task.blockers)}`);
    if (task.nextAction) console.log(`Next: ${task.nextAction}`);
  }
}

function handoff(id?: string): void {
  const cwd = root();
  const task = getTask(cwd, resolveTaskId(cwd, id));
  const agent = agentFromFlags() ?? task.agent;
  const git = getGitState(cwd);
  const checkpoint = makeCheckpoint(task, git, { agent, stopReason: flags.reason });
  const markdown = renderHandoff(task, checkpoint);
  const file = saveCheckpoint(cwd, task.id, checkpoint);

  const handoffFile = file.replace(/\.json$/, ".md");
  fs.writeFileSync(handoffFile, markdown, "utf8");

  if (agent?.sessionId) {
    const now = new Date().toISOString();
    const existing = getSession(cwd, agent.id, agent.sessionId);
    saveSession(cwd, {
      schemaVersion: SCHEMA_VERSION,
      agentId: agent.id,
      sessionId: agent.sessionId,
      taskId: task.id,
      startedAt: existing?.startedAt ?? now,
      endedAt: now,
      ...(flags.reason ? { stopReason: flags.reason } : {}),
      checkpointId: checkpoint.checkpointId,
    });
  }

  task.status = "handoff";
  saveTask(cwd, task);

  console.log("✓ Checkpoint created");
  console.log(`  ${file}`);
  console.log(`✓ Handoff created`);
  console.log(`  ${handoffFile}`);
}

function resume(id?: string): void {
  const cwd = root();
  const task = getTask(cwd, resolveTaskId(cwd, id));
  const file = latestHandoffFile(cwd, task.id);

  if (!file) {
    console.log(`No handoff exists for ${task.id}. Run: agentbrain handoff`);
    return;
  }

  // Taking over is opt-in: without --agent, resume only prints the handoff.
  const agent = agentFromFlags();
  if (agent?.sessionId) {
    task.status = "running";
    task.agent = agent;
    saveTask(cwd, task);
    saveSession(cwd, {
      schemaVersion: SCHEMA_VERSION,
      agentId: agent.id,
      sessionId: agent.sessionId,
      taskId: task.id,
      startedAt: new Date().toISOString(),
    });
  }

  console.log(fs.readFileSync(file, "utf8"));
}

try {
  const [command, subcommand, ...rest] = positionals;
  if (flags.help) usage();

  if (command === "init") {
    initStore(process.cwd());
    console.log("✓ AgentBrain initialized");
    console.log(`  ${brainDir(process.cwd())}`);
  } else if (command === "status") {
    status();
  } else if (command === "task" && subcommand === "create") {
    createTask(rest.join(" "));
  } else if (command === "task" && subcommand === "update") {
    updateTask();
  } else if (command === "task" && subcommand === "list") {
    const cwd = root();
    const active = getProject(cwd).activeTaskId;
    for (const task of listTasks(cwd)) {
      console.log(`${task.id === active ? "*" : " "} ${task.id}\t${task.status}\t${task.objective}`);
    }
  } else if (command === "handoff") {
    handoff(subcommand);
  } else if (command === "resume") {
    resume(subcommand);
  } else {
    usage();
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
