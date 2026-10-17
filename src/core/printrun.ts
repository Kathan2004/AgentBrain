import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt, closeSession, recordSession, takeOver, updateTask, writeCheckpoint } from "./actions.js";
import { focusBrief, focusFor } from "./focus.js";
import { resolveWorker, tierGuide } from "./models.js";
import type { TaskState } from "./state.js";
import { reviewPolicy, reviewSummary } from "./review.js";
import { releaseStandIn } from "./standin.js";
import { execFileSync } from "node:child_process";
import { spawnPortable, gitBinary } from "./platform.js";
import { autoContinue, claudeBinary, codexBinary } from "./delegate.js";
import { OLLAMA_URL, localModel, localModelRoom, ollamaEnv } from "./ollama.js";
import { recordActivity, type ActivityKind } from "./activity.js";
import { describeTool } from "./claudehooks.js";
import { thoughtFrom } from "./thoughts.js";
import { sessionControl } from "./headless.js";
import { getSession, getTask, saveSession } from "./store.js";
import { addWorktree, taskWorkdir } from "./worktree.js";
import { permissionMode } from "./permissions.js";

/**
 * Runs an agent CLI non-interactively on a task: `claude -p` or `codex exec`.
 * This is how the console and the control room start Claude Code or Codex
 * without opening a window. The agent works in the task's worktree, reports
 * progress through AgentBrain, and its tool calls stream into the activity
 * feed. However the run ends, the task is left handed off, in review, or done.
 */
export interface PrintAgent {
  /** "ollama" is Claude Code's CLI pointed at a local model. */
  id: "claude-code" | "codex" | "ollama";
  command: string;
  model?: string;
  env?: Record<string, string>;
  /** The worker id it runs as, when that is a model tier of the platform (claude-code.haiku). */
  worker?: string;
}

/** Who a run is in AgentBrain: the tier it runs as, else the platform. */
const identity = (agent: PrintAgent) => agent.worker ?? agent.id;

/** Claude Code's CLI drives both Claude and the local model. */
const claudeCli = (id: string) => id === "claude-code" || id === "ollama";

/**
 * A local model reads Claude Code's whole prompt on every turn, and its full
 * tool list and extras make that minutes per step. The core tools plus
 * AgentBrain's MCP server (the packet, memory and progress) are all a task needs.
 */
const LOCAL_FLAGS = ["--bare", "--tools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "--strict-mcp-config", "--disable-slash-commands"];

/**
 * How to run a background-capable agent by id (claude or local accepted), or why it can't run.
 * With `root`, a model tier (claude-code.haiku) runs the platform with that model, and the
 * platform itself runs its lead model, when the project set them (agentbrain models).
 */
export function printAgent(name: string, root?: string): PrintAgent {
  const asked = name === "claude" ? "claude-code" : name === "local" ? "ollama" : name;
  if (asked.includes(".")) {
    const resolved = root ? resolveWorker(root, asked) : null;
    if (!resolved?.tier) throw new Error(`Unknown model tier "${name}". See agentbrain models.`);
    return { ...printAgent(resolved.platform), model: resolved.tier.model, worker: asked };
  }
  const lead = root ? resolveWorker(root, asked)?.model : undefined;
  if (lead && (asked === "claude-code" || asked === "codex")) return { ...printAgent(asked), model: lead };
  const id = asked;
  if (id !== "claude-code" && id !== "codex" && id !== "ollama") throw new Error(`${name} can't run in the background: use claude-code, codex or ollama.`);
  const command = id === "codex" ? codexBinary() : claudeBinary();
  if (!command) throw new Error(`${id === "ollama" ? "Claude Code (which drives the local model)" : id} is not installed.`);
  if (id !== "ollama") return { id, command };
  const model = localModel();
  if (!model) throw new Error("No local model yet: run agentbrain local setup");
  const tight = localModelRoom(model);
  if (tight) throw new Error(`The local model ${tight}.`);
  return { id, command, model, env: ollamaEnv(model) };
}

/**
 * One chat turn. onText receives the answer in pieces, to be joined as they are:
 * token by token from a local model, message by message from an agent CLI.
 */
export async function runChat(
  root: string,
  agent: PrintAgent,
  prompt: string,
  onText: (text: string) => void,
): Promise<void> {
  if (agent.id === "ollama" && agent.model) return localChat(agent.model, prompt, onText);
  const args = claudeCli(agent.id)
    ? ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", ...(agent.model ? ["--model", agent.model] : []), ...(agent.id === "ollama" ? LOCAL_FLAGS : [])]
    : ["exec", "--json", "-s", "workspace-write", "-C", root, "--skip-git-repo-check", "-"];
  const child = spawnPortable(agent.command, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...agent.env, AGENTBRAIN_ROOT: root },
  });
  child.stdin!.on("error", () => {});
  child.stdin!.end(`You are in AgentBrain Chat mode. Work from the project root. You may inspect the repository, .agentbrain task state, and .agentbrain/vault memory directly. Do not create a task or worktree unless explicitly asked.\n\n${prompt}\n`);
  let buffer = "";
  // The final "result" event repeats the assistant's text: show it only when nothing else was said.
  let said = false;
  let stderr = "";
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
        if (event?.type === "result") {
          if (!said && typeof event.result === "string" && event.result.trim()) onText(event.result);
          said = true;
          continue;
        }
        const text = typeof event?.item?.text === "string" ? event.item.text
          : Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") : "";
        if (text.trim()) { onText(said ? `\n\n${text}` : text); said = true; }
      } catch {
        // Warnings the CLI prints between events (e.g. about a local model's name) aren't part of the answer.
        if (!/^\[[\w-]+:[\w-]+\]/.test(line)) { onText(said ? `\n\n${line}` : line); said = true; }
      }
    }
  };
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", consume);
  child.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (error) => { onText(`Could not start ${agent.id}: ${error.message}`); resolve(null); });
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  if (buffer.trim()) onText(`\n\n${buffer.trim()}`);
  if (code !== 0 && stderr.trim()) onText(`\n\n${stderr.trim().split("\n").slice(-5).join("\n")}`);
  if (code !== 0) throw new Error(`${agent.id} chat ended${code === null ? " before it could start" : ` with exit code ${code}`}.`);
}

/**
 * Chat with the local model straight through Ollama, streaming: no agent
 * harness (whose long tool prompt a small model takes a minute to read) and no
 * thinking pass. It answers from the brief AgentBrain puts in the prompt.
 */
async function localChat(model: string, prompt: string, onText: (text: string) => void): Promise<void> {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ model, stream: true, think: false, messages: [{ role: "user", content: prompt }] }),
  }).catch((error: Error) => { throw new Error(`Ollama isn't reachable at ${OLLAMA_URL}: ${error.message}`); });
  if (!response.ok || !response.body) throw new Error(`Ollama answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const event = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (event.error) throw new Error(event.error);
      if (event.message?.content) onText(event.message.content);
    }
  }
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
  /** Review instead of build: the agent judges another agent's result (read-only) and votes with agentbrain_review. */
  review?: boolean;
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

function reviewRole(root: string, task: TaskState, me: string): string {
  if (task.review?.standIn?.agent === me) return `You are standing in for the lead reviewer because ${task.review.standIn.why}.`;
  const focus = focusFor(root, task).find((f) => f.agent === me);
  if (focus && !reviewPolicy(root).reviewers.includes(me)) return focusBrief(focus);
  return "You are the lead reviewer on this project: work by other agents counts as done only when you approve it.";
}

function reviewJob(root: string, taskId: string, me: string): string {
  const task = getTask(root, taskId);
  return `## Your job: review this result, don't build

${reviewRole(root, task, me)}
${reviewSummary(root, task, me)}

1. Read the diff (git diff and git log in this directory) and the changed files. Run the tests or checks
   that matter for this change.
2. Judge it on the evidence: does it do what the objective asks, is it correct, are the claims true,
   would you merge it? Don't trust the worker's summary; check.
3. Call agentbrain_review with task_id "${taskId}" and verdict "approve", or "changes" with concrete notes
   (what is wrong, where, and what to do). Cite only files that exist.
4. Do not edit, commit or change the task's status yourself. Your verdict is the whole job.`;
}

const HOW = `## How to work (no one is watching)

You were started by AgentBrain with no developer at the keyboard; nobody will answer questions.
- Work only inside your current directory: it is this task's own Git worktree.
- Make reasonable decisions yourself and record them. If only the developer can unblock you,
  record a blocker and hand off.
- If a file, function or command the task names doesn't exist here, don't create a stand-in for it:
  record that as a blocker and hand off. Your branch may be older than the developer's checkout.
- Commit your work in this worktree when a step is complete, with a plain one-line message.
- When the objective is complete and verified, set the task's status to review.`;

function args(agent: PrintAgent, mcpFile: string, workdir: string, plan = false, allowAll = false, review = false): string[] {
  if (claudeCli(agent.id)) return [...claudeArgs(mcpFile, plan, allowAll, review), ...(agent.model ? ["--model", agent.model] : []), ...(agent.id === "ollama" ? LOCAL_FLAGS : [])];
  const model = agent.model ?? codexModel();
  const sandbox = plan || review ? ["-s", "read-only"] : allowAll ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-s", "workspace-write"];
  return ["exec", "--json", ...sandbox, "-C", workdir, "--skip-git-repo-check", ...(model ? ["-m", model] : []), "-"];
}

function claudeArgs(mcpFile: string, plan: boolean, allowAll: boolean, review: boolean): string[] {
  if (review) {
    // Read and run the tests, nothing else: a reviewer that edits the work is no longer reviewing it.
    return ["-p", "--output-format", "stream-json", "--verbose", "--mcp-config", mcpFile,
      "--allowedTools", "mcp__agentbrain", "Read", "Grep", "Glob", "LS",
      "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)",
      "Bash(npm test:*)", "Bash(npm run:*)", "Bash(npx vitest:*)", "Bash(npx tsc:*)", "Bash(npx jest:*)", "Bash(pytest:*)", "Bash(go test:*)", "Bash(cargo test:*)", "Bash(make test:*)"];
  }
  if (plan) {
    // Read-only: AgentBrain's tools plus reading the code; anything else is refused in -p mode.
    return ["-p", "--output-format", "stream-json", "--verbose", "--mcp-config", mcpFile,
      "--allowedTools", "mcp__agentbrain", "Read", "Grep", "Glob", "LS"];
  }
  return [
    // The prompt goes in on stdin: no command-line length limit, no shell quoting (Windows).
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", allowAll ? "bypassPermissions" : "acceptEdits",
    "--mcp-config", mcpFile,
    // Progress through AgentBrain; Git to commit; edits are already allowed by acceptEdits.
    // Build and test runners too: an agent that can't run the tests can't verify its work.
    "--allowedTools", "mcp__agentbrain", "Bash(agentbrain:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(yarn:*)", "Bash(bun:*)", "Bash(pytest:*)", "Bash(python -m pytest:*)", "Bash(go test:*)", "Bash(go build:*)", "Bash(cargo test:*)", "Bash(cargo build:*)", "Bash(make:*)",
  ];
}

/** One feed line for a line of the agent's JSON output, or null. */
export function describeOutput(agentId: string, line: string, root: string): { kind: ActivityKind; text: string; files?: string[] } | null {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (claudeCli(agentId)) {
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

/** The agent's stated reason in one line of its JSON output: Claude's narration, Codex's reasoning or message. */
export function describeThought(agentId: string, line: string): string | null {
  let event: any;
  try { event = JSON.parse(line); } catch { return null; }
  if (claudeCli(agentId)) return event?.type === "assistant" ? thoughtFrom(event.message?.content) : null;
  const item = event?.item;
  if (!item || !/completed/.test(String(event.type ?? ""))) return null;
  if ((item.type === "reasoning" || item.type === "agent_message") && typeof item.text === "string") return thoughtFrom([{ type: "text", text: item.text }]);
  return null;
}

/** Runs the agent CLI with the prompt on stdin, streaming its progress to the transcript and the feed. */
async function drive(
  root: string, taskId: string, agent: PrintAgent, me: { id: string; sessionId: string }, workdir: string,
  argv: string[], prompt: string, timeoutMinutes: number | undefined,
  control: { stop: string }, log: (text: string) => void,
): Promise<{ code: number | null; stopReason: string; lastText: string }> {
  const child = spawnPortable(agent.command, argv, {
    cwd: workdir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...agent.env, AGENTBRAIN_AGENT: me.id, AGENTBRAIN_SESSION: me.sessionId, AGENTBRAIN_TASK: taskId, AGENTBRAIN_ROOT: root },
  });
  child.stdin!.on("error", () => {});
  child.stdin!.end(prompt);
  // If this runner is stopped, its agent stops too, instead of working on unsupervised.
  const killChild = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  const onSignal = () => { killChild(); process.exit(143); };
  process.once("exit", killChild);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
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
      const said = describeThought(agent.id, line);
      if (said) recordActivity(root, { agent: me.id, session: me.sessionId, task: taskId, kind: "thought", text: said });
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
  const timer = setTimeout(() => { stopReason = `timed out after ${timeoutMinutes ?? 60} min`; child.kill("SIGTERM"); }, (timeoutMinutes ?? 60) * 60_000);
  const stopWatch = setInterval(() => {
    if (fs.existsSync(control.stop)) { stopReason = "stopped by the developer"; child.kill("SIGTERM"); }
  }, 500);
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (error) => { stopReason = `failed to start: ${error.message}`; resolve(null); });
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  clearTimeout(timer);
  clearInterval(stopWatch);
  process.off("exit", killChild);
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  fs.rmSync(control.stop, { force: true });
  return { code, stopReason, lastText };
}

export async function runPrint(root: string, taskId: string, agent: PrintAgent, options: PrintOptions): Promise<{ status: string; stopReason: string }> {
  if (options.review) return runReview(root, taskId, agent, options);
  // A planner reads the main checkout; builders get their own worktree.
  if (!options.plan && !getTask(root, taskId).worktree && fs.existsSync(path.join(root, ".git"))) addWorktree(root, taskId);
  const workdir = taskWorkdir(root, getTask(root, taskId));
  const me = { id: identity(agent), sessionId: `${agent.id === "codex" ? "exec" : "print"}-${Date.now()}` };
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
    ? `${buildPrompt(root, taskId, cli)}\n${PLAN}\n\n${tierGuide(root) ? `${tierGuide(root)}\n\n` : ""}Use parent_task_id "${taskId}" for every piece you delegate.\n`
    : `${buildPrompt(root, taskId, cli)}\n${HOW}\n`;

  const run = await drive(root, taskId, agent, me, workdir, args(agent, mcpFile, workdir, options.plan, permissionMode(root) === "all"), prompt, options.timeoutMinutes, control, log);
  const code = run.code;
  let stopReason = run.stopReason;
  const lastText = run.lastText;
  if (!stopReason) stopReason = code === 0 ? "finished" : `exited with code ${code}: ${lastText.slice(0, 200)}`;

  // However it ended, the next agent (or the reviewer) can pick the task up.
  // Sandboxed agents (codex exec) can edit files but not write Git's data outside their
  // folder, so a clean run's uncommitted work is committed here, in the developer's name.
  if (!options.plan && code === 0 && finished0(root, taskId, me.sessionId)) commitLeftovers(workdir, `${getTask(root, taskId).objective.slice(0, 72)}\n\nWork by ${identity(agent)}, committed by AgentBrain.`);

  // Agents often finish without saying so: a clean exit with work on the branch goes to review.
  const finished = getTask(root, taskId);
  if (!options.plan && code === 0 && finished.status === "running" && finished.agent?.sessionId === me.sessionId && hasWork(workdir, finished.worktree?.base)) {
    updateTask(root, taskId, { status: "review", agent: me, next: "Review the result" });
  }
  const task = getTask(root, taskId);
  const reason = `${identity(agent)} run ended: ${stopReason}`;
  if (task.status === "running" && task.agent?.sessionId === me.sessionId) writeCheckpoint(root, taskId, { agent: me, reason, status: "handoff" });
  else closeSession(root, me, reason);
  log(`ended: ${stopReason}; task is ${getTask(root, taskId).status}`);
  // Nobody has to be watching: a run that stopped early is handed to the next agent.
  if (!options.plan && stopReason !== "stopped by the developer" && getTask(root, taskId).status === "handoff") {
    try { autoContinue(root, taskId, identity(agent), stopReason, options.cli); } catch { /* the task stays handed off */ }
  }
  return { status: getTask(root, taskId).status, stopReason };
}

/**
 * A review run: the agent reads the result in its worktree (read-only), runs
 * the checks it needs and votes with agentbrain_review. The task stays in
 * review; nothing here takes it over or changes its status.
 */
async function runReview(root: string, taskId: string, agent: PrintAgent, options: PrintOptions): Promise<{ status: string; stopReason: string }> {
  const workdir = taskWorkdir(root, getTask(root, taskId));
  const me = { id: identity(agent), sessionId: `review-${Date.now()}` };
  recordSession(root, me, taskId);
  const control = sessionControl(root, me.id, me.sessionId);
  fs.mkdirSync(path.dirname(control.transcript), { recursive: true });
  saveSession(root, { ...getSession(root, me.id, me.sessionId)!, mode: "headless", pid: process.pid, transcript: control.transcript });
  const log = (text: string) => fs.appendFileSync(control.transcript, `[${new Date().toISOString()}] ${text}\n`);
  const mcpFile = `${control.transcript.replace(/\.log$/, "")}.mcp-config`;
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: { agentbrain: { command: options.cli.command, args: [...options.cli.args, "mcp", "--root", workdir, "--agent", me.id, "--session", me.sessionId] } },
  }));
  recordActivity(root, { agent: me.id, session: me.sessionId, task: taskId, kind: "review", text: `Reviewing ${getTask(root, taskId).review?.worker ?? "the"}'s result` });
  const run = await drive(root, taskId, agent, me, workdir, args(agent, mcpFile, workdir, false, false, true), `${reviewJob(root, taskId, me.id)}\n`, options.timeoutMinutes ?? 20, control, log);
  const stopReason = run.stopReason || (run.code === 0 ? "finished" : `exited with code ${run.code}: ${run.lastText.slice(0, 200)}`);
  closeSession(root, me, `${identity(agent)} review ended: ${stopReason}`);
  log(`ended: ${stopReason}`);
  releaseStandIn(root, taskId, me.id, stopReason);
  return { status: getTask(root, taskId).status, stopReason };
}

function hasWork(workdir: string, base: string | undefined): boolean {
  try {
    if (execFileSync(gitBinary(), ["status", "--porcelain"], { cwd: workdir, encoding: "utf8" }).trim()) return true;
    return Boolean(base) && execFileSync(gitBinary(), ["rev-list", "--count", `${base}..HEAD`], { cwd: workdir, encoding: "utf8" }).trim() !== "0";
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
    if (!execFileSync(gitBinary(), ["status", "--porcelain"], { cwd: workdir, encoding: "utf8" }).trim()) return;
    execFileSync(gitBinary(), ["add", "-A"], { cwd: workdir });
    execFileSync(gitBinary(), ["commit", "-q", "-m", message], { cwd: workdir });
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
