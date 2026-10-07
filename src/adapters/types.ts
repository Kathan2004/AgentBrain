export interface AgentCapabilities {
  resume: boolean;
  streaming: boolean;
  toolUse: boolean;
}

export interface AgentContext {
  taskId: string;
  objective: string;
  handoff: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
}

export interface AgentAdapter {
  id: string;
  capabilities(): AgentCapabilities;
  start(context: AgentContext): Promise<AgentSession>;
  resume(context: AgentContext): Promise<AgentSession>;
  stop(session: AgentSession): Promise<void>;
}
