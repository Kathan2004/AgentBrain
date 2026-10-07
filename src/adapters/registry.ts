import path from "node:path";
import { ProcessAdapter, type ProcessAgentDefinition } from "./process.js";

/**
 * Built-in terminal agents. Each takes the AgentBrain prompt as its opening
 * message and stays interactive. Flags reflect each CLI's documented usage;
 * they are not exercised in CI against the real tools.
 */
export const BUILTIN_AGENTS: ProcessAgentDefinition[] = [
  { id: "claude-code", name: "Claude Code", command: "claude", args: (p) => [p] },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    command: "codex",
    fallbacks: ["/Applications/Codex.app/Contents/Resources/codex"],
    args: (p) => [p],
  },
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: (p) => ["--prompt-interactive", p] },
  { id: "cursor", name: "Cursor CLI", command: "cursor-agent", args: (p) => [p] },
  { id: "copilot", name: "GitHub Copilot CLI", command: "copilot", args: (p) => ["--interactive", p] },
  // Aider has no "interactive with an opening message" flag; load the prompt as read-only context.
  { id: "aider", name: "Aider", command: "aider", args: (_p, file) => ["--read", file] },
];

const ALIASES: Record<string, string> = { claude: "claude-code", "cursor-agent": "cursor" };

export function builtinAdapter(name: string): ProcessAdapter | null {
  const id = ALIASES[name] ?? name;
  const def = BUILTIN_AGENTS.find((a) => a.id === id);
  return def ? new ProcessAdapter(def) : null;
}

/**
 * Any other terminal agent: `agentbrain run -- <command> [args...]`.
 * `{prompt}` / `{prompt_file}` in args are replaced; the prompt file path is
 * also exported as AGENTBRAIN_PROMPT_FILE.
 */
export function customAdapter(argv: string[], id?: string): ProcessAdapter {
  const [command, ...rest] = argv;
  if (!command) throw new Error("Missing command after --");
  return new ProcessAdapter({
    id: id ?? path.basename(command),
    name: command,
    command,
    args: (prompt, file) =>
      rest.map((arg) => arg.replaceAll("{prompt_file}", file).replaceAll("{prompt}", prompt)),
  });
}
