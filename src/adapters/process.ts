import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter, AgentCapabilities, AgentContext, AgentSession, ExitInfo } from "./types.js";

/** Resolves a command name against PATH the way a shell would. */
export function findOnPath(command: string, envPath = process.env.PATH ?? ""): string | null {
  if (command.includes("/")) return fs.existsSync(command) ? path.resolve(command) : null;
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export interface ProcessAgentDefinition {
  id: string;
  name: string;
  command: string;
  /** Absolute paths to try when `command` is not on PATH (e.g. CLIs bundled in desktop apps). */
  fallbacks?: string[];
  /**
   * The launcher returns as soon as the agent is open (e.g. `code chat`), so
   * process exit does not mean the agent stopped. No auto-handoff on exit; the
   * agent hands off itself via the AgentBrain instructions.
   */
  detached?: boolean;
  /** Runs before the agent (same executable), e.g. to open the project window. Empty: skip. */
  prepare?(cwd: string, here: boolean): string[];
  /** Builds argv (without the command) from the prompt text and prompt file. */
  args(prompt: string, promptFile: string, cwd: string, here: boolean): string[];
}

/**
 * Adapter for terminal coding agents: starts the agent as a child process on
 * the user's terminal with the AgentBrain prompt as its first message.
 * `resume` is the same launch — the continuation lives in the prompt.
 */
export class ProcessAdapter implements AgentAdapter {
  readonly id: string;
  private readonly children = new Map<string, ChildProcess>();

  constructor(readonly definition: ProcessAgentDefinition) {
    this.id = definition.id;
  }

  capabilities(): AgentCapabilities {
    return { launchable: true, resume: true, streaming: false, toolUse: true };
  }

  /** Executable to launch, or null if the agent isn't installed. */
  resolve(): string | null {
    return (
      findOnPath(this.definition.command) ??
      this.definition.fallbacks?.find((file) => findOnPath(file) !== null) ??
      null
    );
  }

  available(): boolean {
    return this.resolve() !== null;
  }

  /**
   * Environment for the agent. Detached launchers hand off to a long-lived app
   * (VS Code) that would keep AGENTBRAIN_* in every terminal it opens, long
   * after this session ends, so they get none of it.
   */
  private env(context: AgentContext): NodeJS.ProcessEnv {
    if (!this.definition.detached) return { ...process.env, ...context.env };
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENTBRAIN_")));
  }

  async start(context: AgentContext): Promise<AgentSession> {
    const executable = this.resolve() ?? this.definition.command;
    const env = this.env(context);
    const prepareArgs = this.definition.prepare?.(context.cwd, Boolean(context.here)) ?? [];
    if (prepareArgs.length) {
      const result = spawnSync(executable, prepareArgs, {
        cwd: context.cwd,
        env,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
    }
    const child = spawn(executable, this.definition.args(context.handoff, context.promptFile, context.cwd, Boolean(context.here)), {
      cwd: context.cwd,
      env,
      stdio: "inherit",
    });
    const sessionId = context.env.AGENTBRAIN_SESSION ?? `s-${Date.now()}`;
    this.children.set(sessionId, child);

    const exited = new Promise<ExitInfo>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.children.delete(sessionId);
        resolve({ code, signal });
      });
    });
    return { id: sessionId, agentId: this.id, pid: child.pid, exited };
  }

  resume(context: AgentContext): Promise<AgentSession> {
    return this.start(context);
  }

  async stop(session: AgentSession): Promise<void> {
    this.children.get(session.id)?.kill("SIGTERM");
  }
}
