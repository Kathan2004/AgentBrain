import fs from "node:fs";
import { recordActivity } from "./activity.js";
import path from "node:path";
import { AcpClient, DEFAULT_ALLOWED_KINDS, type AcpEvent, type ToolKind } from "../adapters/acp.js";
import { briefContext, closeSession, takeOver, writeCheckpoint } from "./actions.js";
import { brainDir } from "./paths.js";
import { getSession, getTask, saveSession } from "./store.js";
import { addWorktree, taskWorkdir } from "./worktree.js";

export interface AcpAgentDefinition {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export interface HeadlessOptions {
  /** How the agent should launch AgentBrain's MCP server. */
  cli: { command: string; args: string[] };
  allowed?: ToolKind[];
  /** Prompts per run: the brief, then "continue" while the agent keeps making progress. */
  maxTurns?: number;
  timeoutMinutes?: number;
  /** Run in the main checkout instead of the task's own worktree. */
  inPlace?: boolean;
  onEvent?: (event: AcpEvent) => void;
  /** Use this session id (set by `--detach`, which needs to know it up front). */
  sessionId?: string;
  /** After the agent's work ends, keep it alive this long for follow-up messages. */
  lingerMinutes?: number;
}

export interface HeadlessResult {
  taskId: string;
  sessionId: string;
  workdir: string;
  turns: number;
  stopReason: string;
  status: string;
  transcript: string;
}

const PROTOCOL = `## How to work (headless)

You are running headless: no developer is watching and nobody will answer questions.

- Work only inside your current working directory; it is this task's own Git worktree.
- Use the AgentBrain MCP tools: call agentbrain_update after each meaningful step (close
  planned items with done: [numbers]; record decisions with their reasons, and failures).
- Make reasonable decisions yourself and record them as decisions. If something only the
  developer can resolve stops you, record it as a blocker and call agentbrain_handoff.
- Commit your work in this worktree when a step is complete and tests pass.
- When the objective is complete and verified, call agentbrain_update with status "review".`;

export function headlessPrompt(root: string, taskId: string): string {
  return `${briefContext(root, taskId)}\n${PROTOCOL}\n`;
}

/**
 * Runs an ACP agent on a task with no UI. The task gets its own worktree
 * (unless inPlace), the agent gets AgentBrain's MCP server with this run's
 * identity, and the run always ends with the task handed off, in review, or
 * otherwise accounted for.
 */
/** Control files next to a headless session's record: messages in, stop request. */
export function sessionControl(root: string, agentId: string, sessionId: string) {
  const base = path.join(brainDir(root), "agents", agentId, "sessions", sessionId);
  return { inbox: `${base}.inbox`, stop: `${base}.stop`, transcript: `${base}.log`, output: `${base}.out` };
}

/** Queue a message for a running headless session; it becomes the agent's next prompt. */
export function sendToSession(root: string, agentId: string, sessionId: string, text: string): void {
  fs.appendFileSync(sessionControl(root, agentId, sessionId).inbox, `${JSON.stringify({ at: new Date().toISOString(), text })}\n`);
}

export function requestStop(root: string, agentId: string, sessionId: string): void {
  fs.writeFileSync(sessionControl(root, agentId, sessionId).stop, new Date().toISOString());
}

function takeInbox(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const tmp = `${file}.${process.pid}.reading`;
  fs.renameSync(file, tmp);
  const lines = fs.readFileSync(tmp, "utf8").split("\n").filter(Boolean);
  fs.rmSync(tmp);
  return lines.map((line) => {
    try {
      return String(JSON.parse(line).text);
    } catch {
      return line;
    }
  });
}

/**
 * Runs an ACP agent on a task with no UI. The task gets its own worktree
 * (unless inPlace), the agent gets AgentBrain's MCP server with this run's
 * identity, and the run always ends with the task handed off, in review, or
 * otherwise accounted for.
 *
 * While it runs, the developer can watch the transcript, send messages (they
 * become the next prompt, in the same agent session) or ask it to stop. With
 * `lingerMinutes`, the agent stays alive after its work ends so follow-up
 * messages continue the same session instead of starting anew.
 */
export async function runHeadless(
  root: string,
  taskId: string,
  def: AcpAgentDefinition,
  options: HeadlessOptions,
): Promise<HeadlessResult> {
  if (!options.inPlace && !getTask(root, taskId).worktree) addWorktree(root, taskId);
  const workdir = taskWorkdir(root, getTask(root, taskId));
  const agent = { id: def.id, sessionId: options.sessionId ?? `acp-${Date.now()}` };
  takeOver(root, taskId, agent);

  const control = sessionControl(root, agent.id, agent.sessionId);
  const transcript = control.transcript;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const session = getSession(root, agent.id, agent.sessionId)!;
  saveSession(root, { ...session, mode: "headless", pid: process.pid, transcript });
  const log = (event: AcpEvent) => {
    fs.appendFileSync(transcript, `[${new Date().toISOString()}] ${event.kind}: ${event.text}\n`);
    // Tool calls and file writes also go to the live feed (messages and thoughts stay in the transcript).
    if (event.kind === "tool" || event.kind === "fs" || event.kind === "permission") {
      recordActivity(root, { agent: agent.id, session: agent.sessionId, task: taskId, kind: event.kind === "fs" ? "edit" : "tool", text: event.text.split("\n")[0] });
    }
    options.onEvent?.(event);
  };

  const client = new AcpClient({
    command: def.command,
    args: def.args,
    cwd: workdir,
    allowedKinds: options.allowed ?? DEFAULT_ALLOWED_KINDS,
    onEvent: log,
  });

  let turns = 0;
  let stopReason = "not started";
  let timedOut = false;
  let stopRequested = false;
  let sessionId: string | null = null;
  const cancel = () => {
    if (sessionId) client.cancel(sessionId);
    setTimeout(() => client.stop(), 5000).unref();
  };
  const timer = options.timeoutMinutes
    ? setTimeout(() => {
        timedOut = true;
        cancel();
      }, options.timeoutMinutes * 60_000)
    : null;
  timer?.unref();
  // The developer can stop a run from anywhere (terminal app, web page, CLI).
  const stopWatch = setInterval(() => {
    if (!stopRequested && fs.existsSync(control.stop)) {
      stopRequested = true;
      log({ kind: "other", text: "stop requested by the developer" });
      cancel();
    }
  }, 500);
  stopWatch.unref();

  /** Waits for developer messages (or a stop) for up to `minutes`. */
  const waitForMessages = async (minutes: number): Promise<string[]> => {
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until && !stopRequested && !timedOut) {
      const messages = takeInbox(control.inbox);
      if (messages.length) return messages;
      await new Promise((r) => setTimeout(r, 500));
    }
    return [];
  };

  try {
    client.start();
    await client.initialize();
    sessionId = await client.newSession([
      {
        name: "agentbrain",
        command: options.cli.command,
        args: [...options.cli.args, "mcp", "--root", workdir, "--agent", agent.id, "--session", agent.sessionId],
        env: [],
      },
    ]);

    let prompt = headlessPrompt(root, taskId);
    let autoTurns = 0;
    for (;;) {
      turns++;
      const before = getTask(root, taskId).updatedAt;
      log({ kind: "other", text: `turn ${turns}: prompting` });
      stopReason = await client.prompt(sessionId, prompt);
      if (timedOut || stopRequested || stopReason !== "end_turn") break;

      // Messages from the developer come first, in the same agent session.
      let messages = takeInbox(control.inbox);
      const task = getTask(root, taskId);
      const progressed = task.updatedAt !== before;
      if (!messages.length && task.status === "running" && progressed && ++autoTurns < (options.maxTurns ?? 3)) {
        prompt = `continue\n\n${briefContext(root, taskId)}`;
        continue;
      }
      if (!messages.length && options.lingerMinutes) {
        log({ kind: "other", text: `waiting up to ${options.lingerMinutes} min for messages` });
        messages = await waitForMessages(options.lingerMinutes);
      }
      if (!messages.length) break;
      for (const text of messages) log({ kind: "other", text: `developer: ${text}` });
      prompt = `Message from the developer:\n\n${messages.join("\n\n")}\n\nHandle it, keep AgentBrain updated, then carry on with the task.`;
    }
  } catch (error) {
    stopReason = `error: ${(error as Error).message}`;
    log({ kind: "other", text: stopReason });
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(stopWatch);
    client.stop();
    await Promise.race([client.exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    fs.rmSync(control.stop, { force: true });
  }
  if (timedOut) stopReason = `timed out after ${options.timeoutMinutes} min`;
  else if (stopRequested) stopReason = "stopped by the developer";

  // The run is over; make sure the next agent can pick the task up.
  const task = getTask(root, taskId);
  const reason = `${def.id} headless run ended: ${stopReason}`;
  if (task.status === "running") writeCheckpoint(root, taskId, { agent, reason, status: "handoff" });
  else closeSession(root, agent, reason);
  log({ kind: "other", text: `ended: ${stopReason}; task is ${getTask(root, taskId).status}` });

  return {
    taskId,
    sessionId: agent.sessionId,
    workdir,
    turns,
    stopReason,
    status: getTask(root, taskId).status,
    transcript,
  };
}
