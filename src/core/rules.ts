import fs from "node:fs";
import path from "node:path";

/**
 * Agent instruction files. IDE agents (Cursor, Copilot in VS Code, ...) can't
 * be launched by AgentBrain, but they read these files automatically and can
 * run terminal commands — so the instructions are the integration.
 */
export interface RulesTarget {
  id: string;
  file: string;
  /** Suggested `--agent` id for agents reading this file. */
  agentId: string;
  /** Whole-file targets are owned by AgentBrain; others get a marked block. */
  wholeFile?: boolean;
}

export const RULES_TARGETS: RulesTarget[] = [
  { id: "agents", file: "AGENTS.md", agentId: "<your-agent-name, e.g. codex, cursor, copilot>" },
  { id: "claude", file: "CLAUDE.md", agentId: "claude-code" },
  { id: "gemini", file: "GEMINI.md", agentId: "gemini" },
  { id: "cursor", file: ".cursor/rules/agentbrain.mdc", agentId: "cursor", wholeFile: true },
  { id: "copilot", file: ".github/copilot-instructions.md", agentId: "copilot" },
];

const START = "<!-- agentbrain:start -->";
const END = "<!-- agentbrain:end -->";

export function rulesBody(cli: string, agentId: string): string {
  return `## AgentBrain: task continuity across coding agents

This project uses AgentBrain to move tasks between AI coding agents. Another agent
may have worked on the current task before you, and another may continue after you.

If the \`agentbrain_*\` MCP tools are available, use them (agentbrain_brief,
agentbrain_update, agentbrain_handoff) instead of the commands below.

**When the developer asks you to work on, continue or resume the current task**
(a bare "continue", "resume" or "keep going" means exactly this, even mid-conversation:
other agents may have changed the task since your earlier messages, so AgentBrain, not
the chat history, is the source of truth):
run this first and treat its output as your brief:

    ${cli} resume --agent ${agentId}

It shows the objective, completed and remaining work, decisions, known failures,
the Git state and the next action. Continue from there; do not ask the developer
to re-explain. If there is no active task and the developer gave you a new one, run
\`${cli} task create "<objective>"\` first.

**While working**, after each meaningful step (you may be cut off without warning):

    ${cli} task update --done "<finished step>" --todo "<new step>" --decision "<decision and why>" --failure "<what failed>" --next "<next action>"

- \`--done\` / \`--fixed\` take the item's text or any unique part of it.
- Objective complete and verified: \`${cli} task update --status review --next "Review the changes"\`
- Stopping early, or the developer is switching agents: \`${cli} handoff --reason "<why>"\`

Never put secrets, tokens or credentials in AgentBrain fields.
`;
}

function render(target: RulesTarget, cli: string): string {
  const body = rulesBody(cli, target.agentId);
  if (target.id === "cursor") {
    return `---\ndescription: AgentBrain task continuity (resume, record progress, hand off)\nalwaysApply: true\n---\n\n${body}`;
  }
  return `${START}\n${body}${END}\n`;
}

/**
 * Writes or refreshes the AgentBrain section in each target file. Content
 * outside the marked block is preserved, so running this again is safe.
 */
export function writeRules(root: string, cli: string, only?: string[]): { file: string; action: string }[] {
  const targets = only?.length ? RULES_TARGETS.filter((t) => only.includes(t.id)) : RULES_TARGETS;
  const unknown = (only ?? []).filter((id) => !RULES_TARGETS.some((t) => t.id === id));
  if (unknown.length) {
    throw new Error(`Unknown rules target(s): ${unknown.join(", ")}. Use: ${RULES_TARGETS.map((t) => t.id).join(", ")}`);
  }

  return targets.map((target) => {
    const file = path.join(root, target.file);
    const block = render(target, cli);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    if (target.wholeFile || !fs.existsSync(file)) {
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, block, "utf8");
      return { file: target.file, action: existed ? "updated" : "created" };
    }

    const current = fs.readFileSync(file, "utf8");
    const start = current.indexOf(START);
    const end = current.indexOf(END);
    const next =
      start !== -1 && end > start
        ? current.slice(0, start) + block.trimEnd() + current.slice(end + END.length)
        : `${current.trimEnd()}\n\n${block}`;
    fs.writeFileSync(file, next, "utf8");
    return { file: target.file, action: start !== -1 ? "updated" : "appended" };
  });
}
