import fs from "node:fs";
import path from "node:path";
import { AcpClient, DEFAULT_ALLOWED_KINDS, type AcpEvent, type ToolKind } from "../adapters/acp.js";
import { briefContext, closeSession, takeOver, writeCheckpoint } from "./actions.js";
import { brainDir } from "./paths.js";
import { getTask } from "./store.js";
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
export async function runHeadless(
  root: string,
  taskId: string,
  def: AcpAgentDefinition,
  options: HeadlessOptions,
): Promise<HeadlessResult> {
  if (!options.inPlace && !getTask(root, taskId).worktree) addWorktree(root, taskId);
  const workdir = taskWorkdir(root, getTask(root, taskId));
  const agent = { id: def.id, sessionId: `acp-${Date.now()}` };
  takeOver(root, taskId, agent);

  const transcript = path.join(brainDir(root), "agents", agent.id, "sessions", `${agent.sessionId}.log`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const log = (event: AcpEvent) => {
    fs.appendFileSync(transcript, `[${new Date().toISOString()}] ${event.kind}: ${event.text}\n`);
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
  let sessionId: string | null = null;
  const timer = options.timeoutMinutes
    ? setTimeout(() => {
        timedOut = true;
        if (sessionId) client.cancel(sessionId);
        setTimeout(() => client.stop(), 5000).unref();
      }, options.timeoutMinutes * 60_000)
    : null;
  timer?.unref();

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
    for (turns = 1; turns <= (options.maxTurns ?? 3); turns++) {
      const before = getTask(root, taskId).updatedAt;
      log({ kind: "other", text: `turn ${turns}: prompting` });
      stopReason = await client.prompt(sessionId, prompt);
      const task = getTask(root, taskId);
      if (timedOut || stopReason !== "end_turn" || task.status !== "running") break;
      // Keep going only while the agent is actually recording progress.
      if (task.updatedAt === before) break;
      prompt = `continue\n\n${briefContext(root, taskId)}`;
    }
    turns = Math.min(turns, options.maxTurns ?? 3);
  } catch (error) {
    stopReason = `error: ${(error as Error).message}`;
    log({ kind: "other", text: stopReason });
  } finally {
    if (timer) clearTimeout(timer);
    client.stop();
    await Promise.race([client.exited, new Promise((r) => setTimeout(r, 5000).unref())]);
  }
  if (timedOut) stopReason = `timed out after ${options.timeoutMinutes} min`;

  // The run is over; make sure the next agent can pick the task up.
  const task = getTask(root, taskId);
  const reason = `${def.id} headless run ended: ${stopReason}`;
  if (task.status === "running") writeCheckpoint(root, taskId, { agent, reason, status: "handoff" });
  else closeSession(root, agent, reason);

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
