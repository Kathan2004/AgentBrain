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
import { awaitingVote, reviewerNotice, reviewSummary, reviewTask } from "../core/review.js";
import { routeTask } from "../core/routing.js";
import { sendMessage, takeUnread, unreadFor } from "../core/messages.js";
import { delegate } from "../core/delegate.js";
import { lessonsDigest, recall, remember } from "../core/vault.js";
import { listSessions } from "../core/store.js";
import { taskTimeline } from "../core/timeline.js";
import { taskForDir } from "../core/worktree.js";
import { getProject, getTask, listTasks } from "../core/store.js";
import type { AgentRef } from "../core/state.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_VERSION = "0.13.0";

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

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "agentbrain_brief",
    description:
      "Get the live state of the active AgentBrain task (or task_id): objective, completed and remaining " +
      "work, decisions, known failures, blockers, Git state and next action. Call this before starting or " +
      "continuing work on the project's task.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } } },
  },
  {
    name: "agentbrain_log",
    description: "Show the task timeline oldest first as dated agent events. This is read-only and does not claim the task.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } } },
  },
  {
    name: "agentbrain_route",
    description: "Suggest available agents for the task with scores, reasons and commands. This only suggests; the developer decides which agent to use.",
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
        drop: listParam("Wrong or duplicate remaining items to remove, not finished work (text or numbers)"),
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
    name: "agentbrain_message",
    description:
      "Talk to the other agents working on this project at the same time (or the developer): coordinate, " +
      "warn about conflicts (\"my uncommitted change to X blocks your merge\"), ask for help or a review. " +
      "to is an agent id (claude-code, vscode, codex, gemini, cursor, developer) or \"all\". Replies arrive in " +
      "your next AgentBrain tool results.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" }, task_id: { type: "string" } },
      required: ["to", "text"],
    },
  },
  {
    name: "agentbrain_delegate",
    description:
      "Hand part of your work to another agent working in parallel. AgentBrain creates the subtask (linked to " +
      "your task), gives it its own Git worktree, picks the best-placed ready agent (or the one you name: " +
      "claude-code, codex, vscode, gemini, any), runs the project's checks on the result and sends it through review. " +
      "You get a message when it is ready. Use it to split large tasks into independent pieces.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "What the other agent should do, self-contained" },
        worker: { type: "string" },
        parent_task_id: { type: "string" },
      },
      required: ["objective"],
    },
  },
  {
    name: "agentbrain_recall",
    description:
      "Search the project's shared memory (the AgentBrain vault): lessons from reviews, decisions and why, which " +
      "files tasks touched, notes other agents and the developer kept. Use it before deciding how to do something.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "agentbrain_remember",
    description:
      "Save something future agents on this project should know (a convention, a gotcha, how a subsystem works) " +
      "as a lasting note in the shared memory. Not for task progress: use agentbrain_update for that.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, text: { type: "string" }, tags: listParam("Optional tags") },
      required: ["title", "text"],
    },
  },
  {
    name: "agentbrain_list_tasks",
    description: "List AgentBrain tasks with their status; the active one is marked with *.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Only listed for the lead agent. */
const REVIEW_TOOL: ToolDef = {
  name: "agentbrain_review",
  description:
    "You review other agents' work (lead or council member): give your verdict on a task in review. Read the " +
    "packet from agentbrain_brief (claims, diff, AgentBrain's own check results, flags) and verify it yourself first. " +
    "Once the reviewers reach a decision, approve merges the task's branch and marks it done; changes sends it back " +
    "with the notes as remaining items.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      verdict: { type: "string", enum: ["approve", "changes"] },
      notes: { type: "string", description: "Required for changes: concrete, one item per line" },
    },
    required: ["task_id", "verdict"],
  },
};

export interface McpServerOptions {
  /** Project root; if omitted, resolved from cwd or the client's MCP roots. */
  root?: string;
  /** Fixed identity (set by `agentbrain run --headless`), instead of deriving it from the client name. */
  agent?: Required<AgentRef>;
  input?: NodeJS.ReadableStream;
  /** How to start AgentBrain itself (for delegating); defaults to this process's script. */
  self?: { command: string; args: string[] };
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
  tools(): ToolDef[] {
    const reviewer = this.root ? reviewerNotice(this.root, this.agent.id) : null;
    const base = reviewer ? [...TOOLS, REVIEW_TOOL] : TOOLS;
    const waiting = reviewer && this.root ? awaitingVote(this.root, this.agent.id) : [];
    const withReviews = waiting.length
      ? base.map((tool) => tool.name === "agentbrain_review"
        ? { ...tool, description: `${tool.description} WAITING FOR YOUR REVIEW: ${waiting.map((t) => `${t.id} by ${t.review?.worker ?? t.agent?.id ?? "unknown"}`).join(", ")}.` }
        : tool)
      : base;
    const unread = this.root ? unreadFor(this.root, this.agent.id).length : 0;
    const withInbox = unread
      ? withReviews.map((tool) => tool.name === "agentbrain_message" ? { ...tool, description: `${tool.description} YOU HAVE ${unread} UNREAD MESSAGE(S): call any AgentBrain tool (e.g. agentbrain_brief) to read them.` } : tool)
      : withReviews;
    const task = this.pendingTask();
    if (!task) return withInbox;
    const live =
      ` TASK IN PROGRESS: ${task.id} "${task.objective}" (${task.status}` +
      (task.agent ? `, last worked on by ${task.agent.id}` : "") +
      `)${task.nextAction ? `; next action: ${task.nextAction}` : ""}. ` +
      "When the developer says continue/resume/keep going, call this first, even mid-conversation: the task may " +
      "have changed since earlier messages (other agents work on it too), and this is the source of truth.";
    return withInbox.map((tool) => (tool.name === "agentbrain_brief" ? { ...tool, description: tool.description + live } : tool));
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
- Other agents work on this project at the same time. For a large task, split off independent pieces with agentbrain_delegate (each gets its own worktree, checks and review; you hear back when it is ready), and coordinate with agentbrain_message.
- Never put secrets in AgentBrain fields.`;
    if (!this.root) return protocol;
    const reviewer = reviewerNotice(this.root, this.agent.id);
    const parts = [this.stateInstructions(protocol), lessonsDigest(this.root), this.waitingNotice(), reviewer].filter(Boolean);
    return parts.join("\n\n");
  }

  /**
   * Tasks the developer delegated to "the next agent you open": whichever
   * agent connects (Claude app, Cursor, a VS Code extension...) offers to take them.
   */
  private waitingNotice(): string {
    if (!this.root) return "";
    const waiting = listTasks(this.root).filter((t) => (t.status === "idle" || t.status === "handoff") && !t.agent);
    if (!waiting.length) return "";
    return `Tasks the developer delegated that are waiting for an agent (tell the developer about them; if they say go, ` +
      `call agentbrain_brief with the task_id and do it):\n${waiting.map((t) => `- ${t.id}: ${t.objective}`).join("\n")}`;
  }

  private stateInstructions(protocol: string): string {
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
      // Every tool result carries messages other agents sent this one since its last call.
      const text = this.runTool(name, args);
      const inbox = this.root ? takeUnread(this.root, this.agent.id) : "";
      return { content: [{ type: "text", text: inbox ? `${text}\n\n${inbox}` : text }] };
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
        // The lead reviewing a finished result gets what it needs to judge it.
        if (args.task_id && reviewerNotice(root, this.agent.id)) {
          const asked = getTask(root, String(args.task_id));
          if (asked.status === "review" && asked.review?.worker !== this.agent.id) {
            return `${reviewSummary(root, asked, this.agent.id)}\n\nGive your verdict with agentbrain_review (task_id ${asked.id}).\n\n${briefContext(root, asked.id)}`;
          }
        }
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
      case "agentbrain_log": {
        const root = this.requireRoot();
        const taskId = resolveTaskId(root, args.task_id, this.agent.id, this.workdir);
        return taskTimeline(root, taskId).map((event) =>
          `${event.timestamp.slice(0, 16).replace("T", " ")} ${event.agent} ${event.event} ${event.reason}`,
        ).join("\n") || "No timeline events.";
      }
      case "agentbrain_route": {
        const root = this.requireRoot();
        const taskId = resolveTaskId(root, args.task_id, this.agent.id, this.workdir);
        const candidates = routeTask(root, taskId).filter((candidate) => candidate.available);
        if (!candidates.length) return "No available agents.";
        return candidates.map((candidate) =>
          `${candidate.name}\t${candidate.mode}\tscore ${candidate.score}\t${candidate.reasons.join("; ") || "no recorded reason"}\t${candidate.command}`,
        ).join("\n");
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
          drop: strings(args.drop),
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
      case "agentbrain_delegate": {
        const root = this.requireRoot();
        const parent = args.parent_task_id ? String(args.parent_task_id) : [...this.claimed].at(-1) ?? this.pendingTask()?.id;
        const result = delegate(root, {
          prompt: String(args.objective ?? ""),
          ...(args.worker ? { worker: String(args.worker) } : {}),
          ...(parent ? { parent } : {}),
          requestedBy: this.agent.id,
        }, this.options.self ?? { command: process.execPath, args: [process.argv[1]] });
        return `Delegated ${result.task.id} to ${result.worker.name} (${result.why}). ` +
          "It works in its own worktree; you'll get a message here when it is ready for review or needs you.";
      }
      case "agentbrain_recall": {
        const root = this.requireRoot();
        const hits = recall(root, String(args.query ?? ""));
        if (!hits.length) return "Nothing in the project's memory matches. If you learn something worth keeping, use agentbrain_remember.";
        return hits.map((h) => `## ${h.note}\n${h.excerpt}`).join("\n\n") + "\n\n(Notes live in .agentbrain/vault; open it in Obsidian to browse.)";
      }
      case "agentbrain_remember": {
        const root = this.requireRoot();
        const file = remember(root, { title: String(args.title ?? ""), text: String(args.text ?? ""), author: this.agent.id, tags: strings(args.tags) });
        return `Saved to the shared memory as ${file}. Every agent on this project can recall it.`;
      }
      case "agentbrain_message": {
        const root = this.requireRoot();
        const message = sendMessage(root, { from: this.agent.id, to: String(args.to ?? "all"), text: String(args.text ?? ""), ...(args.task_id ? { task: String(args.task_id) } : {}) });
        const around = [...new Set(listSessions(root).filter((s) => !s.endedAt && s.agentId !== this.agent.id).map((s) => s.agentId))];
        return `Sent to ${message.to === "all" ? "everyone" : message.to}.` + (around.length ? ` Agents with open sessions: ${around.join(", ")}.` : "");
      }
      case "agentbrain_review": {
        const root = this.requireRoot();
        if (!reviewerNotice(root, this.agent.id)) throw new UserError("Only reviewers (the lead or council members) can review. The developer sets them with agentbrain lead / agentbrain council.");
        const verdict = args.verdict === "approve" ? "approved" : args.verdict === "changes" ? "changes" : null;
        if (!verdict) throw new UserError('verdict must be "approve" or "changes".');
        const result = reviewTask(root, String(args.task_id ?? ""), { verdict, reviewer: this.agent.id, notes: args.notes });
        const left = awaitingVote(root, this.agent.id).length;
        const more = left ? ` ${left} more result(s) waiting for your review.` : " Nothing else is waiting for your review.";
        if (result.conflicts) {
          return `Approved, but ${result.task.id}'s branch conflicts with the main checkout in ${result.conflicts.join(", ")}. ` +
            "The merge was aborted and the task is still in review." + more;
        }
        if (!result.outcome) {
          const t = result.tally;
          return `Vote recorded for ${result.task.id}. No decision yet` +
            (t ? ` (${t.approve.toFixed(1)} approve / ${t.changes.toFixed(1)} changes of ${t.total.toFixed(1)} weight${t.blocked ? `; ${t.blocked}` : ""})` : "") +
            "." + more;
        }
        return (result.outcome === "approved"
          ? `Decided: approved ${result.task.id}${result.merged ? `; merged ${result.merged} commit(s)` : ""}. It is done.`
          : `Decided: ${result.task.id} goes back with the reviewers' notes; it is waiting for an agent to pick it up.`) + more;
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
