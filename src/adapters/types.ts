export interface AgentCapabilities {
  /** Can be started from a terminal command (vs. living inside an IDE). */
  launchable: boolean;
  /** Takes over an existing task from a handoff. */
  resume: boolean;
  streaming: boolean;
  toolUse: boolean;
}

export interface AgentContext {
  /** Project root (contains `.agentbrain/`). */
  cwd: string;
  taskId: string;
  objective: string;
  /** Full continuation prompt: handoff context + AgentBrain instructions. */
  handoff: string;
  /** Same prompt, written to disk, for agents that take a file. */
  promptFile: string;
  /** Extra environment for the agent process. */
  env: Record<string, string>;
  /** Deliver to the agent's already-open session instead of opening the task's folder (`run vscode --here`). */
  here?: boolean;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AgentSession {
  id: string;
  agentId: string;
  pid?: number;
  /** Resolves when the agent process exits. */
  exited?: Promise<ExitInfo>;
}

export interface AgentAdapter {
  id: string;
  capabilities(): AgentCapabilities;
  start(context: AgentContext): Promise<AgentSession>;
  resume(context: AgentContext): Promise<AgentSession>;
  stop(session: AgentSession): Promise<void>;
}
