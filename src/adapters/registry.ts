import fs from "node:fs";
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
  {
    // GitHub Copilot agent mode in VS Code, via the official `code chat` CLI.
    // The brief is attached as a file; the chat message stays short.
    id: "vscode",
    name: "GitHub Copilot in VS Code",
    command: "code",
    fallbacks: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"],
    detached: true,
    prepare: (cwd) => ["--reuse-window", cwd],
    args: (_p, file, cwd) =>
      // With the MCP server connected, Copilot reads live state itself: send
      // what a developer would type. Otherwise attach the brief.
      hasMcp(cwd)
        ? ["chat", "--mode", "agent", "--reuse-window", "continue"]
        : [
            "chat",
            "--mode",
            "agent",
            "--reuse-window",
            "--add-file",
            file,
            "AgentBrain has assigned you the current task. The attached file is your up-to-date brief " +
              "(objective, progress, decisions, failures, Git state, next action). Continue from the next action. " +
              "Do not run `agentbrain resume`; the task is already yours. Record progress with `agentbrain task update` " +
              "after each step, and run `agentbrain handoff --reason \"<why>\"` before you stop.",
          ],
  },
  // Aider has no "interactive with an opening message" flag; load the prompt as read-only context.
  { id: "aider", name: "Aider", command: "aider", args: (_p, file) => ["--read", file] },
];

function hasMcp(cwd: string): boolean {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(cwd, ".vscode/mcp.json"), "utf8")).servers?.agentbrain);
  } catch {
    return false;
  }
}

const ALIASES: Record<string, string> = {
  claude: "claude-code",
  "cursor-agent": "cursor",
  code: "vscode",
  "copilot-vscode": "vscode",
};

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
