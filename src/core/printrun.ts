import fs from "node:fs";
import path from "node:path";
import { buildPrompt, closeSession, takeOver, updateTask, writeCheckpoint } from "./actions.js";
import { execFileSync } from "node:child_process";
import { spawnPortable } from "./platform.js";
import { recordActivity, type ActivityKind } from "./activity.js";
import { describeTool } from "./claudehooks.js";
import { sessionControl } from "./headless.js";
import { getSession, getTask, saveSession } from "./store.js";
import { addWorktree, taskWorkdir } from "./worktree.js";

/**
 * Runs an agent CLI non-interactively on a task: `claude -p` or `codex exec`.
 * This is how the console and the control room start Claude Code or Codex
 * without opening a window. The agent works in the task's worktree, reports
 * progress through AgentBrain, and its tool calls stream into the activity
 * feed. However the run ends, the task is left handed off, in review, or done.
 */
export interface PrintAgent {
  id: "claude-code" | "codex";
  command: string;
}

export interface PrintOptions {
  /** How the agent should launch AgentBrain (MCP server and CLI). */
  cli: { command: string; args: string[] };
  timeoutMinutes?: number;
}

const HOW = `## How to work (no one is watching)

You were started by AgentBrain with no developer at the keyboard; nobody will answer questions.
- Work only inside your current directory: it is this task's own Git worktree.
- Make reasonable decisions yourself and record them. If only the developer can unblock you,
  record a blocker and hand off.
- Commit your work in this worktree when a step is complete.
- When the objective is complete and verified, set the task's status to review.`;

function args(agent: PrintAgent, mcpFile: string, workdir: string): string[] {
  if (agent.id === "claude-code") {
    return [
      // The prompt goes in on stdin: no command-line length limit, no shell quoting (Windows).
      "-p",
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits",
      "--mcp-config", mcpFile,
      // Progress through AgentBrain; Git to commit; edits are already allowed by acceptEdits.
      "--allowedTools", "mcp__agentbrain", "Bash(agentbrain:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    ];
  }
  return ["exec", "--json", "-s", "workspace-write", "-C", workdir, "--skip-git-repo-check", "-"];
}

/** One feed line for a line of the agent's JSON output, or null. */
export function describeOutput(agentId: string, line: string, root: string): { kind: ActivityKind; text: string; files?: string[] } | null {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (agentId === "claude-code") {
    const content = event?.type === "assistant" ? event.message?.content ?? [] : [];
    for (const part of content) {
      if (part?.type === "tool_use") return describeTool(String(part.name), part.input ?? {}, root);
    }
    return null;
  }
  // codex exec --json: item events
  const item = event?.item ?? event?.msg;
  if (!item || (event.type && !/completed|end/.test(String(event.type)))) return null;
  if (item.type === "command_execution" || item.type === "exec_command_end") {
    return { kind: "command", text: `$ ${String(item.command ?? "").split("\n")[0]}` };
  }
  if (item.type === "file_change" || item.type === "patch_apply_end") {
    const files = (item.changes ?? []).map((c: any) => String(c.path ?? "")).filter(Boolean)
      .map((f: string) => (path.isAbsolute(f) ? path.relative(root, f) : f).split(path.sep).join("/"));
    return { kind: "edit", text: `Edited ${files.join(", ") || "files"}`, ...(files.length ? { files } : {}) };
  }
  if (item.type === "mcp_tool_call" && !String(item.server ?? "").includes("agentbrain")) {
    return { kind: "tool", text: `${item.server ?? "mcp"}: ${item.tool ?? ""}` };
  }
  return null;
}

export async function runPrint(root: string, taskId: string, agent: PrintAgent, options: PrintOptions): Promise<{ status: string; stopReason: string }> {
  if (!getTask(root, taskId).worktree && fs.existsSync(path.join(root, ".git"))) addWorktree(root, taskId);
  const workdir = taskWorkdir(root, getTask(root, taskId));
  const me = { id: agent.id, sessionId: `${agent.id === "codex" ? "exec" : "print"}-${Date.now()}` };
  takeOver(root, taskId, me);

  const control = sessionControl(root, me.id, me.sessionId);
  fs.mkdirSync(path.dirname(control.transcript), { recursive: true });
  saveSession(root, { ...getSession(root, me.id, me.sessionId)!, mode: "headless", pid: process.pid, transcript: control.transcript });
  const log = (text: string) => fs.appendFileSync(control.transcript, `[${new Date().toISOString()}] ${text}\n`);

  // The agent reaches AgentBrain over MCP with this run's identity, and via the CLI.
  const mcpFile = `${control.transcript.replace(/\.log$/, "")}.mcp.json`;
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: { agentbrain: { command: options.cli.command, args: [...options.cli.args, "mcp", "--root", workdir, "--agent", me.id, "--session", me.sessionId] } },
  }));
  const cli = [options.cli.command, ...options.cli.args].map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ");
  const prompt = `${buildPrompt(root, taskId, cli)}\n${HOW}\n`;

  const child = spawnPortable(agent.command, args(agent, mcpFile, workdir), {
    cwd: workdir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTBRAIN_AGENT: me.id, AGENTBRAIN_SESSION: me.sessionId, AGENTBRAIN_TASK: taskId, AGENTBRAIN_ROOT: root },
  });
  child.stdin!.on("error", () => {});
  child.stdin!.end(prompt);
  let buffer = "";
  let lastText = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      log(line.slice(0, 4000));
      const described = describeOutput(agent.id, line, workdir);
      if (described) recordActivity(root, { agent: me.id, session: me.sessionId, task: taskId, ...described });
      try {
        const event = JSON.parse(line);
        const text = event?.result ?? event?.item?.text ?? event?.msg?.message;
        if (typeof text === "string" && text) lastText = text;
      } catch { /* not JSON */ }
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { log(`stderr: ${chunk.trim()}`); lastText = chunk.trim() || lastText; });

  let stopReason = "";
  const timer = setTimeout(() => { stopReason = `timed out after ${options.timeoutMinutes ?? 60} min`; child.kill("SIGTERM"); }, (options.timeoutMinutes ?? 60) * 60_000);
  const stopWatch = setInterval(() => {
    if (fs.existsSync(control.stop)) { stopReason = "stopped by the developer"; child.kill("SIGTERM"); }
  }, 500);
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (error) => { stopReason = `failed to start: ${error.message}`; resolve(null); });
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  clearTimeout(timer);
  clearInterval(stopWatch);
  fs.rmSync(control.stop, { force: true });
  if (!stopReason) stopReason = code === 0 ? "finished" : `exited with code ${code}: ${lastText.slice(0, 200)}`;

  // However it ended, the next agent (or the reviewer) can pick the task up.
  // Agents often finish without saying so: a clean exit with work on the branch goes to review.
  const finished = getTask(root, taskId);
  if (code === 0 && finished.status === "running" && finished.agent?.sessionId === me.sessionId && hasWork(workdir, finished.worktree?.base)) {
    updateTask(root, taskId, { status: "review", agent: me, next: "Review the result" });
  }
  const task = getTask(root, taskId);
  const reason = `${agent.id} run ended: ${stopReason}`;
  if (task.status === "running" && task.agent?.sessionId === me.sessionId) writeCheckpoint(root, taskId, { agent: me, reason, status: "handoff" });
  else closeSession(root, me, reason);
  log(`ended: ${stopReason}; task is ${getTask(root, taskId).status}`);
  return { status: getTask(root, taskId).status, stopReason };
}

function hasWork(workdir: string, base: string | undefined): boolean {
  try {
    if (execFileSync("git", ["status", "--porcelain"], { cwd: workdir, encoding: "utf8" }).trim()) return true;
    return Boolean(base) && execFileSync("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: workdir, encoding: "utf8" }).trim() !== "0";
  } catch {
    return false;
  }
}
