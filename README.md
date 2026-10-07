# AgentBrain

> One project. Any coding agent. No lost context.

AgentBrain is a local-first continuity layer for AI coding agents. It keeps the
execution state of a software task — objective, progress, decisions, failures,
Git state, next action — with the repository, so the task can move from one
agent to another without starting the conversation over.

Git tells you what the code looks like. AgentBrain tells the next agent what was
happening and what to do next.

AgentBrain is **not** an IDE, a model provider, an agent swarm, or a replacement
for Git. It never commits, and never reads or stores file contents.

## Install

```bash
git clone <this repo> && cd agentbrain
npm install
npm run build
npm link          # puts `agentbrain` on your PATH
```

Requires Node 20+ and Git.

## Use it

```bash
cd your-project
agentbrain init
agentbrain task create "Implement OAuth login"
agentbrain rules          # teach your agents the protocol (see below)
```

### Terminal agents

```bash
agentbrain run claude     # Claude Code works on the task...
                          # ...hits its usage limit and exits
                          # → AgentBrain writes a handoff checkpoint automatically
agentbrain run codex      # Codex starts with the full brief and continues
```

`run` launches the agent's normal interactive UI with the AgentBrain brief as its
first message. The brief tells the agent to record progress as it goes:

```bash
agentbrain task update --done "OAuth callback" --todo "Refresh-token rotation" \
  --decision "httpOnly cookies, not localStorage" --next "Implement rotation"
```

When the agent exits without handing off (usage limit, crash, Ctrl-C, closed
terminal), AgentBrain records a handoff with the reason. Built in: `claude`,
`codex`, `gemini`, `cursor` (cursor-agent), `copilot` (Copilot CLI), `aider`.
Anything else:

```bash
agentbrain run --agent my-agent -- my-agent-cli --message {prompt}
```

### IDE agents (Cursor, Copilot in VS Code, Windsurf, …)

These live inside the editor, so AgentBrain can't launch them. Instead,
`agentbrain rules` writes instruction files they read automatically:

| File | Read by |
|---|---|
| `.cursor/rules/agentbrain.mdc` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot (VS Code, JetBrains) |
| `AGENTS.md` | Codex, Cursor, Copilot, and most other agents |
| `CLAUDE.md` | Claude Code |
| `GEMINI.md` | Gemini CLI |

Existing content in those files is preserved; AgentBrain only manages its own
marked block. Then, in the agent's chat (agent mode):

> Continue the AgentBrain task.

The agent runs `agentbrain resume --agent cursor`, gets the brief, records
progress, and runs `agentbrain handoff` when you switch away. You can also
switch by hand at any time:

```bash
agentbrain handoff --reason "switching to Cursor for the UI work"
agentbrain resume          # prints the brief — paste it into any agent
```

### Everything else

```bash
agentbrain status                 # active task, progress, last checkpoint
agentbrain checkpoint             # snapshot without stopping
agentbrain task list / task use <id>
agentbrain agents                 # which agents are installed + session history
agentbrain --help
```

## What's stored

```text
.agentbrain/
├── project.json                      # active task, redaction patterns
├── tasks/<task-id>/
│   ├── task.json                     # objective, status, progress, decisions, ...
│   └── checkpoints/<cp-id>.{json,md} # snapshots + rendered handoffs
└── agents/<agent-id>/sessions/
    ├── <session-id>.json             # start/end, stop reason, checkpoint
    └── <session-id>.prompt.md        # exactly what the agent was given
```

Plain JSON and Markdown — commit it with the repo to share task state, or add it
to `.gitignore` to keep it local. Checkpoints follow
[`schemas/checkpoint.schema.json`](schemas/checkpoint.schema.json).

Secrets are redacted from everything AgentBrain stores (API keys, tokens, private
keys, `password=` values, credentials in URLs). Add project patterns with
`"redactPatterns": ["..."]` in `.agentbrain/project.json`.

## Status

- **Tested:** the full CLI, Git capture, redaction, instruction files, and
  `run` (including auto-handoff) against stub agents that behave like the real
  CLIs. `npm test` runs it all.
- **Not yet tested against the real agents.** The launch flags follow each
  CLI's documented usage; reports and fixes are welcome.
- **Not built yet:** headless execution over ACP, worktree isolation, agent
  routing. See [`SPEC.md`](SPEC.md) for the spec and roadmap.

## Development

```bash
npm test         # type-checks, then runs unit + end-to-end tests
npm run smoke    # full CLI workflow in a throwaway repo
```

## License

MIT
