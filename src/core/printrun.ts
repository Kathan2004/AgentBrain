import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt, closeSession, takeOver, updateTask, writeCheckpoint } from "./actions.js";
import { execFileSync } from "node:child_process";
import { spawnPortable } from "./platform.js";
import { autoContinue } from "./delegate.js";
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

export async function runChat(
  root: string,
  agent: PrintAgent,
  prompt: string,
  onText: (text: string) => void,
): Promise<void> {
  const args = agent.id === "claude-code"
    ? ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]
    : ["exec", "--json", "-s", "workspace-write", "-C", root, "--skip-git-repo-check", "-"];
  const child = spawnPortable(agent.command, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTBRAIN_ROOT: root },
  });
  child.stdin!.on("error", () => {});
  child.stdin!.end(`You are in AgentBrain Chat mode. Work from the project root. You may inspect the repository, .agentbrain task state, and .agentbrain/vault memory directly. Do not create a task or worktree unless explicitly asked.\n\n${prompt}\n`);
  let buffer = "";
  const consume = (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as any;
        const content = event?.message?.content ?? event?.item?.content;
        const text = typeof event?.result === "string" ? event.result
          : typeof event?.item?.text === "string" ? event.item.text
            : Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") : "";
        if (text) onText(text);
      } catch {
        onText(line);
      }
    }
  };
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", consume);
  child.stderr!.on("data", (chunk: string) => { if (chunk.trim()) onText(chunk.trim()); });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (error) => { onText(`Could not start ${agent.id}: ${error.message}`); resolve(null); });
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  if (buffer.trim()) onText(buffer.trim());
  if (code !== 0) throw new Error(`${agent.id} chat ended${code === null ? " before it could start" : ` with exit code ${code}`}.`);
}

export interface PrintOptions {
  /** How the agent should launch AgentBrain (MCP server and CLI). */
  cli: { command: string; args: string[] };
  timeoutMinutes?: number;
  /**
   * Plan instead of build: the agent reads the code (no edits), splits the task
   * into independent pieces and hands each to another agent with agentbrain_delegate.
   */
  plan?: boolean;
}

const PLAN = `## Your job: plan and delegate, don't build

You are the planner. Several coding agents can work on this project in parallel, each in its own
Git worktree. Read the code you need (you can't edit anything), then:

1. Split the objective into independent pieces that different agents can do at the same time
   without editing the same files. Two to six pieces is usual; one is fine for a small objective.
2. For each piece call agentbrain_delegate with a self-contained objective: what to change, in which
   files, how to verify it (which tests or commands), and that it must commit and set its task to
   review. Leave worker empty so AgentBrain picks the best-placed agent, unless one is clearly better.
3. Record the plan with agentbrain_update: a decision saying how you split it and why, and one todo
   per piece naming its task id.
4. Do not write code and do not mark this task done: it stays open until its pieces are reviewed.`;

const HOW = `## How to work (no one is watching)

You were started by AgentBrain with no developer at the keyboard; nobody will answer questions.
- Work only inside your current directory: it is this task's own Git worktree.
- Make reasonable decisions yourself and record them. If only the developer can unblock you,
  record a blocker and hand off.
- Commit your work in this worktree when a step is complete.
- When the objective is complete and verified, set the task's status to review.`;

function args(agent: PrintAgent, mcpFile: string, workdir: string, plan = false): string[] {
  if (agent.id === "claude-code" && plan) {
    // Read-only: AgentBrain's tools plus reading the code; anything else is refused in -p mode.
    return ["-p", "--output-format", "stream-json", "--verbose", "--mcp-config", mcpFile,
      "--allowedTools", "mcp__agentbrain", "Read", "Grep", "Glob", "LS"];
  }
  if (agent.id === "claude-code") {
    return [
      // The prompt goes in on stdin: no command-line length limit, no shell quoting (Windows).
      "-p",
      "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits",
      "--mcp-config", mcpFile,
      // Progress through AgentBrain; Git to commit; edits are already allowed by acceptEdits.
      // Build and test runners too: an agent that can't run the tests can't verify its work.
      "--allowedTools", "mcp__agentbrain", "Bash(agentbrain:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
      "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(yarn:*)", "Bash(bun:*)", "Bash(pytest:*)", "Bash(python -m pytest:*)", "Bash(go test:*)", "Bash(go build:*)", "Bash(cargo test:*)", "Bash(cargo build:*)", "Bash(make:*)",
    ];
  }
  const model = codexModel();
  return ["exec", "--json", "-s", plan ? "read-only" : "workspace-write", "-C", workdir, "--skip-git-repo-check", ...(model ? ["-m", model] : []), "-"];
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
  // A planner reads the main checkout; builders get their own worktree.
  if (!options.plan && !getTask(root, taskId).worktree && fs.existsSync(path.join(root, ".git"))) addWorktree(root, taskId);
  const workdir = taskWorkdir(root, getTask(root, taskId));
  const me = { id: agent.id, sessionId: `${agent.id === "codex" ? "exec" : "print"}-${Date.now()}` };
  takeOver(root, taskId, me);

  const control = sessionControl(root, me.id, me.sessionId);
  fs.mkdirSync(path.dirname(control.transcript), { recursive: true });
  saveSession(root, { ...getSession(root, me.id, me.sessionId)!, mode: "headless", pid: process.pid, transcript: control.transcript });
  const log = (text: string) => fs.appendFileSync(control.transcript, `[${new Date().toISOString()}] ${text}\n`);

  // The agent reaches AgentBrain over MCP with this run's identity, and via the CLI.
  // Not *.json: session records are the .json files in this folder.
  const mcpFile = `${control.transcript.replace(/\.log$/, "")}.mcp-config`;
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: { agentbrain: { command: options.cli.command, args: [...options.cli.args, "mcp", "--root", workdir, "--agent", me.id, "--session", me.sessionId] } },
  }));
  const cli = [options.cli.command, ...options.cli.args].map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ");
  const prompt = options.plan
    ? `${buildPrompt(root, taskId, cli)}\n${PLAN}\n\nUse parent_task_id "${taskId}" for every piece you delegate.\n`
    : `${buildPrompt(root, taskId, cli)}\n${HOW}\n`;

  const child = spawnPortable(agent.command, args(agent, mcpFile, workdir, options.plan), {
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
        const text = event?.result ?? event?.item?.text ?? event?.msg?.message ??
          (event?.type === "error" || event?.type === "turn.failed" ? String(event?.message ?? event?.error?.message ?? "").replace(/^\{.*"message\\?":\\?"([^"\\]+).*$/, "$1") : undefined);
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
  // Sandboxed agents (codex exec) can edit files but not write Git's data outside their
  // folder, so a clean run's uncommitted work is committed here, in the developer's name.
  if (!options.plan && code === 0 && finished0(root, taskId, me.sessionId)) commitLeftovers(workdir, `${getTask(root, taskId).objective.slice(0, 72)}\n\nWork by ${agent.id}, committed by AgentBrain.`);

  // Agents often finish without saying so: a clean exit with work on the branch goes to review.
  const finished = getTask(root, taskId);
  if (!options.plan && code === 0 && finished.status === "running" && finished.agent?.sessionId === me.sessionId && hasWork(workdir, finished.worktree?.base)) {
    updateTask(root, taskId, { status: "review", agent: me, next: "Review the result" });
  }
  const task = getTask(root, taskId);
  const reason = `${agent.id} run ended: ${stopReason}`;
  if (task.status === "running" && task.agent?.sessionId === me.sessionId) writeCheckpoint(root, taskId, { agent: me, reason, status: "handoff" });
  else closeSession(root, me, reason);
  log(`ended: ${stopReason}; task is ${getTask(root, taskId).status}`);
  // Nobody has to be watching: a run that stopped early is handed to the next agent.
  if (!options.plan && stopReason !== "stopped by the developer" && getTask(root, taskId).status === "handoff") {
    try { autoContinue(root, taskId, agent.id, stopReason, options.cli); } catch { /* the task stays handed off */ }
  }
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

function finished0(root: string, taskId: string, sessionId: string): boolean {
  const task = getTask(root, taskId);
  return task.agent?.sessionId === sessionId || task.status === "review";
}

function commitLeftovers(workdir: string, message: string): void {
  try {
    if (!execFileSync("git", ["status", "--porcelain"], { cwd: workdir, encoding: "utf8" }).trim()) return;
    execFileSync("git", ["add", "-A"], { cwd: workdir });
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: workdir });
  } catch {
    // leave it uncommitted; review shows it
  }
}

/**
 * The model to ask Codex for. Codex's built-in default isn't offered on every
 * plan (ChatGPT sign-ins reject it), so unless the developer chose one in
 * ~/.codex/config.toml, use the coding model Codex itself listed for this account.
 */
export function codexModel(home = os.homedir()): string | null {
  try {
    const config = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    if (/^\s*model\s*=/m.test(config)) return null;
  } catch {
    // no config
  }
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, ".codex", "models_cache.json"), "utf8")) as { models?: { slug: string; priority?: number }[] };
    const models = (cache.models ?? []).filter((m) => !/review/i.test(m.slug)).sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    return models[0]?.slug ?? null;
  } catch {
    return null;
  }
}
