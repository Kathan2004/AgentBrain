/**
 * AgentBrain as an MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Every MCP-capable coding agent (Claude Code, Copilot in VS Code, Cursor,
 * Codex, Gemini CLI, Windsurf, ...) that connects gets:
 *
 * - `instructions` generated from the live project state at connect time,
 *   which clients place in the agent's system prompt — so a brand-new chat
 *   already knows the active task without the developer pasting anything;
 * - tools to read the current brief and record progress, so state stays live
 *   for whichever agent comes next;
 * - an automatic handoff checkpoint if the agent disconnects while it still
 *   owns a running task.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  briefContext,
  createTask,
  resolveTaskId,
  takeOver,
  updateTask,
  writeCheckpoint,
  type TaskPatch,
} from "../core/actions.js";
import { findRoot } from "../core/paths.js";
import { taskForDir } from "../core/worktree.js";
import { getProject, getTask, listTasks } from "../core/store.js";
import type { AgentRef } from "../core/state.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_VERSION = "0.7.0";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Message {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: Json };
}

/** Maps MCP clientInfo.name to a stable AgentBrain agent id. */
export function agentIdFromClient(name: string | undefined): string {
  const raw = (name ?? "mcp-client").toLowerCase();
  if (raw.includes("claude")) return "claude-code";
  if (raw.includes("cursor")) return "cursor";
  if (raw.includes("codex")) return "codex";
  if (raw.includes("gemini")) return "gemini";
  if (raw.includes("windsurf") || raw.includes("codeium")) return "windsurf";
  if (raw.includes("visual studio code") || raw === "vscode" || raw.includes("copilot")) return "vscode";
  return raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp-client";
}

const listParam = (description: string) => ({ type: "array", items: { type: "string" }, description });

const TOOLS = [
  {
    name: "agentbrain_brief",
    description:
      "Get the live state of the active AgentBrain task (or task_id): objective, completed and remaining " +
      "work, decisions, known failures, blockers, Git state and next action. Call this before starting or " +
      "continuing work on the project's task.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } } },
  },
  {
    name: "agentbrain_update",
    description:
      "Record progress on the task after each meaningful step, so any agent can continue if you are cut off. " +
      "Close planned items by putting their numbers from the Remaining list in done (numbers refer to the latest " +
      "brief or update result); only use todo for genuinely new steps.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        done: listParam("Finished steps (text, or remaining-item numbers)"),
        todo: listParam("New remaining steps"),
        decisions: listParam("Decisions made, with the reason"),
        failures: listParam("What failed and how"),
        fixed: listParam("Known failures now fixed (text or numbers)"),
        blockers: listParam("Things only the developer can resolve"),
        unblock: listParam("Blockers now resolved (text or numbers)"),
        next: { type: "string", description: "The very next action" },
        status: {
          type: "string",
          enum: ["running", "review", "blocked", "failed", "done"],
          description: "Use 'review' when the objective is complete and verified",
        },
      },
    },
  },
  {
    name: "agentbrain_handoff",
    description:
      "Snapshot the task and mark it ready for another agent. Use when stopping before the task is finished " +
      "or when the developer says they are switching agents.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, reason: { type: "string" } },
      required: ["reason"],
    },
  },
  {
    name: "agentbrain_checkpoint",
    description: "Snapshot task and Git state without stopping (e.g. after tests pass).",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, note: { type: "string" } } },
  },
  {
    name: "agentbrain_create_task",
    description:
      "Start tracking a NEW objective the developer has explicitly described. Never use this for " +
      "'continue', 'resume', 'keep going' or similar: those mean continue the task in progress (agentbrain_brief).",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        confirm_new: {
          type: "boolean",
          description: "Set true only if the developer asked for a different objective while another task is unfinished",
        },
      },
      required: ["objective"],
    },
  },
  {
    name: "agentbrain_list_tasks",
    description: "List AgentBrain tasks with their status; the active one is marked with *.",
    inputSchema: { type: "object", properties: {} },
  },
];

export interface McpServerOptions {
  /** Project root; if omitted, resolved from cwd or the client's MCP roots. */
  root?: string;
  /** Fixed identity (set by `agentbrain run --headless`), instead of deriving it from the client name. */
  agent?: Required<AgentRef>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (message: string) => void;
}

export class AgentBrainMcpServer {
  private root: string | null;
  private agent: Required<AgentRef> = { id: "mcp-client", sessionId: `mcp-${Date.now()}` };
  /** Tasks this connection took over; checkpointed on disconnect if still ours. */
  private readonly claimed = new Set<string>();
  private nextRequestId = 1;
  private readonly pending = new Map<number, (message: Message) => void>();
  private readonly out: NodeJS.WritableStream;
  private readonly log: (message: string) => void;
  private closed = false;
  private watcher: fs.FSWatcher | null = null;
  private lastToolsKey = "";

  /** The folder the agent has open: a task worktree, or the main checkout. */
  private readonly workdir: string;

  constructor(private readonly options: McpServerOptions = {}) {
    this.workdir = options.root ?? process.cwd();
    this.root = findRoot(this.workdir);
    this.out = options.output ?? process.stdout;
    this.log = options.log ?? ((m) => process.stderr.write(`[agentbrain-mcp] ${m}\n`));
  }

  start(): Promise<void> {
    const input = this.options.input ?? process.stdin;
    let buffer = "";
    input.setEncoding?.("utf8");
    return new Promise((resolve) => {
      input.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) void this.receive(line);
        }
      });
      input.on("end", () => {
        this.close("MCP session ended");
        resolve();
      });
    });
  }

  /**
   * Another agent (or the CLI, or a commit) changing the task makes our tool
   * descriptions stale; tell the client to re-fetch them.
   */
  private watch(): void {
    if (this.watcher || !this.root) return;
    this.lastToolsKey = JSON.stringify(this.tools());
    let timer: NodeJS.Timeout | null = null;
    try {
      this.watcher = fs.watch(`${this.root}/.agentbrain`, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.notifyIfChanged(), 250);
        timer.unref();
      });
      this.watcher.unref();
    } catch (error) {
      this.log(`not watching for changes: ${String(error)}`);
    }
  }

  notifyIfChanged(): void {
    if (this.closed) return;
    const key = JSON.stringify(this.tools());
    if (key === this.lastToolsKey) return;
    this.lastToolsKey = key;
    this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  /** Called on disconnect: hand off any task this agent still owns. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    // Under `run --headless` the runner owns the session and hands off itself, with a better reason.
    if (!this.root || this.options.agent) return;
    for (const taskId of this.claimed) {
      try {
        const task = getTask(this.root, taskId);
        if (task.status === "running" && task.agent?.sessionId === this.agent.sessionId) {
          writeCheckpoint(this.root, taskId, { agent: this.agent, reason: `${this.agent.id}: ${reason}`, status: "handoff" });
          this.log(`handed off ${taskId}`);
        }
      } catch (error) {
        this.log(`could not checkpoint ${taskId}: ${String(error)}`);
      }
    }
  }

  private send(message: Message): void {
    this.out.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params?: Json): Promise<Message> {
    const id = this.nextRequestId++;
    this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "timeout" } });
      }, 5000).unref();
    });
  }

  private async receive(line: string): Promise<void> {
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    // Response to one of our requests (roots/list).
    if (message.method === undefined && message.id !== undefined) {
      const resolve = this.pending.get(Number(message.id));
      if (resolve) {
        this.pending.delete(Number(message.id));
        resolve(message);
      }
      return;
    }

    const isRequest = message.id !== undefined && message.id !== null;
    try {
      const result = await this.handle(message.method!, message.params ?? {});
      if (isRequest) this.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (!isRequest) return;
      const code = error instanceof MethodNotFound ? -32601 : -32603;
      this.send({ jsonrpc: "2.0", id: message.id, error: { code, message: (error as Error).message } });
    }
  }

  private async handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize": {
        this.agent = this.options.agent ?? { id: agentIdFromClient(params.clientInfo?.name), sessionId: `mcp-${Date.now()}` };
        this.clientSupportsRoots = Boolean(params.capabilities?.roots);
        const requested = String(params.protocolVersion ?? "");
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true }, resources: { listChanged: false } },
          serverInfo: { name: "agentbrain", title: "AgentBrain", version: SERVER_VERSION },
          instructions: this.instructions(),
        };
      }
      case "notifications/initialized":
        if (!this.root && this.clientSupportsRoots) await this.resolveRootFromClient();
        this.watch();
        return undefined;
      case "notifications/roots/list_changed":
        if (!this.root) await this.resolveRootFromClient();
        this.watch();
        return undefined;
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.tools() };
      case "tools/call":
        return this.callTool(String(params.name), params.arguments ?? {});
      case "resources/list":
        return {
          resources: this.root
            ? [{ uri: "agentbrain://brief", name: "brief", title: "AgentBrain task brief", mimeType: "text/markdown" }]
            : [],
        };
      case "resources/read":
        if (params.uri !== "agentbrain://brief") throw new Error(`Unknown resource ${params.uri}`);
        return { contents: [{ uri: params.uri, mimeType: "text/markdown", text: this.brief() }] };
      default:
        if (method?.startsWith("notifications/")) return undefined;
        throw new MethodNotFound(`Method not found: ${method}`);
    }
  }

  private clientSupportsRoots = false;

  /** The unfinished task an agent should pick up, if any. */
  private pendingTask(): ReturnType<typeof getTask> | null {
    if (!this.root) return null;
    try {
      const here = taskForDir(this.root, this.workdir);
      const active = here?.id ?? getProject(this.root).activeTaskId;
      if (!active) return null;
      const task = getTask(this.root, active);
      return ["idle", "running", "checkpoint", "handoff", "blocked"].includes(task.status) ? task : null;
    } catch {
      return null;
    }
  }

  /**
   * Tool descriptions are always in the model's context (server instructions
   * are not shown by every client), so the task in progress goes there too.
   */
  tools(): typeof TOOLS {
    const task = this.pendingTask();
    if (!task) return TOOLS;
    const live =
      ` TASK IN PROGRESS: ${task.id} "${task.objective}" (${task.status}` +
      (task.agent ? `, last worked on by ${task.agent.id}` : "") +
      `)${task.nextAction ? `; next action: ${task.nextAction}` : ""}. ` +
      "When the developer says continue/resume/keep going, call this first, even mid-conversation: the task may " +
      "have changed since earlier messages (other agents work on it too), and this is the source of truth.";
    return TOOLS.map((tool) => (tool.name === "agentbrain_brief" ? { ...tool, description: tool.description + live } : tool));
  }

  private async resolveRootFromClient(): Promise<void> {
    const response = await this.request("roots/list");
    for (const root of response.result?.roots ?? []) {
      if (typeof root.uri !== "string" || !root.uri.startsWith("file:")) continue;
      const found = findRoot(fileURLToPath(root.uri));
      if (found) {
        this.root = found;
        this.log(`project root from client: ${found}`);
        return;
      }
    }
  }

  private requireRoot(): string {
    if (!this.root) {
      throw new UserError(
        "This workspace has no AgentBrain project. Ask the developer to run `agentbrain init` in the repository.",
      );
    }
    return this.root;
  }

  /** Server instructions: the protocol plus the live state at connect time. */
  instructions(): string {
    const protocol = `AgentBrain keeps this project's task state so that any coding agent can continue work exactly where the previous one stopped.

- Before working on the project's task, call agentbrain_brief and continue from its next action as if you had done the earlier work yourself. Never ask the developer to re-explain the task.
- After each meaningful step (you may be cut off without warning), call agentbrain_update with done/todo/decisions/failures/next.
- When the objective is complete and verified, call agentbrain_update with status "review".
- If you stop before finishing, or the developer is switching agents, call agentbrain_handoff with the reason.
- "Continue", "resume", "keep going" and similar mean: call agentbrain_brief and continue the task it returns. Do this even in the middle of a conversation: other agents may have changed the task since your earlier messages, so AgentBrain, not the chat history, is the source of truth. Do not create a task for them.
- Only if the developer explicitly describes a new objective, call agentbrain_create_task.
- Never put secrets in AgentBrain fields.`;
    if (!this.root) return protocol;
    try {
      const project = getProject(this.root);
      const taskId = taskForDir(this.root, this.workdir)?.id ?? project.activeTaskId;
      if (!taskId) return `${protocol}\n\nThere is no active task yet.`;
      const task = getTask(this.root, taskId);
      if (task.status === "done") return `${protocol}\n\nThe last task (${task.id}) is done; no task is in progress.`;
      return `${protocol}\n\nState when this session connected (call agentbrain_brief for the latest):\n\n${briefContext(this.root, task.id)}`;
    } catch (error) {
      return `${protocol}\n\n(Could not read AgentBrain state: ${String(error)})`;
    }
  }

  private brief(taskId?: string): string {
    const root = this.requireRoot();
    return briefContext(root, resolveTaskId(root, taskId, this.agent.id, this.workdir));
  }

  /** First write by this connection takes the task over (status running, session recorded). */
  private claim(root: string, taskId: string): void {
    const task = getTask(root, taskId);
    if (task.agent?.sessionId !== this.agent.sessionId) takeOver(root, taskId, this.agent);
    this.claimed.add(taskId);
  }

  private async callTool(name: string, args: Record<string, any>): Promise<unknown> {
    try {
      return { content: [{ type: "text", text: this.runTool(name, args) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${(error as Error).message}` }], isError: true };
    }
  }

  private runTool(name: string, args: Record<string, any>): string {
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : undefined;

    switch (name) {
      case "agentbrain_brief": {
        // Chat history can point an agent at a task that's already finished;
        // steer it to the one actually waiting.
        const root = this.requireRoot();
        const waiting = this.pendingTask();
        if (args.task_id && waiting && waiting.id !== args.task_id) {
          const asked = getTask(root, String(args.task_id));
          if (asked.status === "done" || asked.status === "review") {
            return `Task ${asked.id} is already ${asked.status}. The task in progress is ${waiting.id}; continue that one:\n\n${this.brief(waiting.id)}`;
          }
        }
        // A handed-off task is waiting for whoever picks it up: reading its brief
        // claims it. A task another agent is actively running is left alone.
        const taskId = resolveTaskId(root, args.task_id, this.agent.id, this.workdir);
        if (getTask(root, taskId).status === "handoff") this.claim(root, taskId);
        return this.brief(taskId);
      }
      case "agentbrain_list_tasks": {
        const root = this.requireRoot();
        const active = getProject(root).activeTaskId;
        const tasks = listTasks(root);
        if (!tasks.length) return "No tasks yet.";
        return tasks.map((t) => `${t.id === active ? "*" : " "} ${t.id}\t${t.status}\t${t.objective}`).join("\n");
      }
      case "agentbrain_create_task": {
        const root = this.requireRoot();
        const waiting = this.pendingTask();
        if (waiting && waiting.agent?.sessionId !== this.agent.sessionId && args.confirm_new !== true) {
          return (
            `Not created: task ${waiting.id} is unfinished and waiting to be continued. ` +
            "If the developer said continue/resume, carry on with it — here is where it stands:\n\n" +
            `${this.brief(waiting.id)}\n\nOnly if the developer explicitly asked for a different objective, ` +
            "call agentbrain_create_task again with confirm_new: true."
          );
        }
        const task = createTask(root, String(args.objective ?? ""));
        this.claim(root, task.id);
        return `Created ${task.id} and assigned it to ${this.agent.id}.\n\n${this.brief(task.id)}`;
      }
      case "agentbrain_update": {
        const root = this.requireRoot();
        const taskId = resolveTaskId(root, args.task_id, this.agent.id, this.workdir);
        this.claim(root, taskId);
        const patch: TaskPatch = {
          status: args.status,
          done: strings(args.done),
          todo: strings(args.todo),
          decisions: strings(args.decisions),
          failures: strings(args.failures),
          fixed: strings(args.fixed),
          blockers: strings(args.blockers),
          unblock: strings(args.unblock),
          next: args.next === undefined ? undefined : String(args.next),
          agent: this.agent,
        };
        const task = updateTask(root, taskId, patch);
        return `Recorded. ${task.id} is ${task.status}; ${task.completed.length} done.` +
          (task.nextAction ? ` Next: ${task.nextAction}` : "") +
          remainingFeedback(task.status, task.remaining);
      }
      case "agentbrain_checkpoint":
      case "agentbrain_handoff": {
        const root = this.requireRoot();
        const taskId = resolveTaskId(root, args.task_id, this.agent.id, this.workdir);
        this.claim(root, taskId);
        const status = name === "agentbrain_handoff" ? "handoff" : "checkpoint";
        const result = writeCheckpoint(root, taskId, {
          agent: this.agent,
          reason: args.reason ?? args.note,
          status,
        });
        return status === "handoff"
          ? `Handed off ${taskId} (${result.checkpoint.checkpointId}). Any agent can continue it now.`
          : `Checkpoint ${result.checkpoint.checkpointId} saved for ${taskId}.`;
      }
      default:
        throw new UserError(`Unknown tool ${name}`);
    }
  }
}

/**
 * Agents tend to describe finished work in their own words and leave the
 * planned items open, so every update shows them what is still listed.
 */
export function remainingFeedback(status: string, remaining: string[]): string {
  if (!remaining.length) return "\nRemaining: none.";
  const list = remaining.map((item, i) => `${i + 1}. ${item}`).join("\n");
  const finishing = status === "review" || status === "done";
  return finishing
    ? `\nWARNING: you marked the task ${status} but ${remaining.length} item(s) are still listed as remaining:\n${list}\n` +
        "If they are finished, call agentbrain_update with done set to their numbers; otherwise set status back to running."
    : `\nRemaining (mark finished ones with done: [numbers]; don't re-add them as todo):\n${list}`;
}

class MethodNotFound extends Error {}
class UserError extends Error {}

/** `agentbrain mcp [--root <dir>]` */
export async function runMcpServer(root?: string, agent?: Required<AgentRef>): Promise<void> {
  // Some clients pass "${workspaceFolder}" through uninterpolated.
  const usable = root && !root.includes("${") && fs.existsSync(root) ? root : undefined;
  const server = new AgentBrainMcpServer({ root: usable, agent });
  const stop = () => {
    server.close("MCP server stopped");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await server.start();
}
