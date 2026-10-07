import fs from "node:fs";
import path from "node:path";

/**
 * Registers the AgentBrain MCP server in each agent's project-level config, so
 * every agent opened on this repo gets live task state on its own.
 */
export interface ConnectTarget {
  id: string;
  file: string;
  agent: string;
  /** Key holding the server map. */
  key: "mcpServers" | "servers";
  entry(command: string, args: string[]): Record<string, unknown>;
}

const stdio = (command: string, args: string[]) => ({ command, args });

export const CONNECT_TARGETS: ConnectTarget[] = [
  { id: "claude", file: ".mcp.json", agent: "Claude Code", key: "mcpServers", entry: (c, a) => ({ type: "stdio", ...stdio(c, a) }) },
  {
    id: "vscode",
    file: ".vscode/mcp.json",
    agent: "GitHub Copilot in VS Code",
    key: "servers",
    entry: (c, a) => ({ type: "stdio", ...stdio(c, [...a, "--root", "${workspaceFolder}"]) }),
  },
  { id: "cursor", file: ".cursor/mcp.json", agent: "Cursor", key: "mcpServers", entry: stdio },
  { id: "gemini", file: ".gemini/settings.json", agent: "Gemini CLI", key: "mcpServers", entry: stdio },
];

export interface ConnectResult {
  file: string;
  agent: string;
  action: "created" | "updated" | "unchanged" | "skipped";
  note?: string;
}

/**
 * Adds an `agentbrain` server to each config, leaving every other setting and
 * server untouched. Files that aren't plain JSON (e.g. JSONC with comments) are
 * skipped rather than rewritten.
 */
export function connectAgents(root: string, command: string, args: string[], only?: string[]): ConnectResult[] {
  const unknown = (only ?? []).filter((id) => !CONNECT_TARGETS.some((t) => t.id === id));
  if (unknown.length) {
    throw new Error(`Unknown target(s): ${unknown.join(", ")}. Use: ${CONNECT_TARGETS.map((t) => t.id).join(", ")}`);
  }
  const targets = only?.length ? CONNECT_TARGETS.filter((t) => only.includes(t.id)) : CONNECT_TARGETS;

  return targets.map((target) => {
    const file = path.join(root, target.file);
    const entry = target.entry(command, args);
    let config: Record<string, any> = {};
    const existed = fs.existsSync(file);
    if (existed) {
      try {
        config = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return {
          file: target.file,
          agent: target.agent,
          action: "skipped",
          note: `not plain JSON; add this under "${target.key}": "agentbrain": ${JSON.stringify(entry)}`,
        };
      }
    }
    const servers = (config[target.key] ??= {});
    if (JSON.stringify(servers.agentbrain) === JSON.stringify(entry)) {
      return { file: target.file, agent: target.agent, action: "unchanged" };
    }
    servers.agentbrain = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { file: target.file, agent: target.agent, action: existed ? "updated" : "created" };
  });
}
