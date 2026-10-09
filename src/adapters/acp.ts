/**
 * Minimal Agent Client Protocol (ACP) client: AgentBrain drives an ACP agent
 * (e.g. Claude Code via claude-code-acp, Gemini CLI via --experimental-acp)
 * headlessly over JSON-RPC on the agent's stdio.
 *
 * AgentBrain plays the editor's role: it serves the agent's file reads and
 * writes (confined to the task's working directory) and answers permission
 * requests from a policy, since no human is watching.
 */
import type { ChildProcess } from "node:child_process";
import { spawnPortable } from "../core/platform.js";
import fs from "node:fs";
import path from "node:path";

export const ACP_PROTOCOL_VERSION = 1;

/** ACP tool-call kinds. */
export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** Allowed without asking in a headless run: nothing here can leave the worktree or run commands. */
export const DEFAULT_ALLOWED_KINDS: ToolKind[] = ["read", "edit", "search", "think"];

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export interface AcpEvent {
  kind: "message" | "thought" | "tool" | "plan" | "permission" | "fs" | "stderr" | "other";
  text: string;
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  /** Working directory: the agent's cwd and the only place it may read or write. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  allowedKinds?: ToolKind[];
  onEvent?: (event: AcpEvent) => void;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class AcpClient {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly allowed: Set<string>;
  private readonly root: string;
  exited: Promise<number | null> = Promise.resolve(null);

  constructor(private readonly options: AcpClientOptions) {
    this.allowed = new Set(options.allowedKinds ?? DEFAULT_ALLOWED_KINDS);
    this.root = fs.realpathSync(options.cwd);
  }

  private emit(kind: AcpEvent["kind"], text: string): void {
    this.options.onEvent?.({ kind, text });
  }

  start(): void {
    const child = spawnPortable(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.receive(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => this.emit("stderr", chunk.trimEnd()));
    this.exited = new Promise((resolve) => {
      child.once("error", (error) => {
        this.failAll(error);
        resolve(null);
      });
      child.once("exit", (code) => {
        this.failAll(new Error(`agent exited (code ${code})`));
        resolve(code);
      });
    });
  }

  private failAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private write(message: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit("other", `unparseable output: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.method && message.id !== undefined) void this.answer(message);
      else if (message.method) this.onNotification(message.method, message.params);
      else if (message.id !== undefined) {
        const pending = this.pending.get(Number(message.id));
        if (!pending) continue;
        this.pending.delete(Number(message.id));
        if (message.error) pending.reject(new Error(message.error.message ?? "ACP error"));
        else pending.resolve(message.result);
      }
    }
  }

  /** Requests from the agent to the client. */
  private async answer(message: { id: number | string; method: string; params: any }): Promise<void> {
    try {
      const result = await this.handle(message.method, message.params ?? {});
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: (error as Error).message } });
    }
  }

  /** Resolves a path the agent gave us, refusing anything outside the working directory. */
  private confine(file: string): string {
    const resolved = path.resolve(this.root, file);
    const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      throw new Error(`Access outside the task's working directory is not allowed: ${file}`);
    }
    return real;
  }

  private async handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.decide(params);
      case "fs/read_text_file": {
        const file = this.confine(String(params.path));
        let content = fs.readFileSync(file, "utf8");
        if (params.line || params.limit) {
          const lines = content.split("\n");
          const start = Math.max(0, (params.line ?? 1) - 1);
          content = lines.slice(start, params.limit ? start + params.limit : undefined).join("\n");
        }
        this.emit("fs", `read ${path.relative(this.root, file)}`);
        return { content };
      }
      case "fs/write_text_file": {
        if (!this.allowed.has("edit")) throw new Error("Editing files is not allowed in this run.");
        const file = this.confine(String(params.path));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(params.content), "utf8");
        this.emit("fs", `wrote ${path.relative(this.root, file)}`);
        return null;
      }
      default:
        throw new Error(`Method not supported by AgentBrain: ${method}`);
    }
  }

  /** Permission policy: allow the configured tool kinds, reject the rest. */
  private decide(params: any): unknown {
    const kind: string = params.toolCall?.kind ?? "other";
    const title: string = params.toolCall?.title ?? kind;
    const options: { optionId: string; kind: string }[] = params.options ?? [];
    const allow = this.allowed.has(kind);
    const pick =
      options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ??
      options.find((o) => o.kind.startsWith(allow ? "allow" : "reject"));
    this.emit("permission", `${allow ? "allowed" : "rejected"} ${kind}: ${title}`);
    return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private onNotification(method: string, params: any): void {
    if (method !== "session/update") return;
    const update = params?.update ?? {};
    const text = (content: any) => (content?.type === "text" ? String(content.text) : "");
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.emit("message", text(update.content));
        break;
      case "agent_thought_chunk":
        this.emit("thought", text(update.content));
        break;
      case "tool_call":
      case "tool_call_update":
        if (update.title || update.status) {
          this.emit("tool", `${update.status ?? "pending"} ${update.kind ?? ""} ${update.title ?? update.toolCallId ?? ""}`.trim());
        }
        break;
      case "plan":
        this.emit("plan", (update.entries ?? []).map((e: any) => `[${e.status}] ${e.content}`).join("; "));
        break;
      default:
        break;
    }
  }

  async initialize(): Promise<any> {
    return this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "agentbrain", version: "0.7.0" },
    });
  }

  async newSession(mcpServers: AcpMcpServer[]): Promise<string> {
    const result = await this.request<{ sessionId: string }>("session/new", { cwd: this.root, mcpServers });
    return result.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const result = await this.request<{ stopReason: string }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return result?.stopReason ?? "unknown";
  }

  cancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  stop(): void {
    this.child?.stdin?.end();
    const child = this.child;
    if (child && child.exitCode === null) {
      setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2000).unref();
    }
  }
}
