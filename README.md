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
agentbrain doctor # checks the installation and project integration
```

Requires Node 20+ and Git.

## Use it

```bash
cd your-project
agentbrain init
agentbrain task create "Implement OAuth login"
agentbrain rules          # teach your agents the protocol (see below)
```

### Live state for every agent (MCP)

To connect the agents installed in your editor to the same live AgentBrain
state, run this once from the project:

```bash
agentbrain connect
```

This configures the MCP server, writes the agent instruction files, and
installs the post-commit hook. A new chat receives the current task brief when
it connects, so you do not need to paste a brief or say `resume` first. Agents
can read the brief, update progress, checkpoint, hand off, create a task, and
list tasks through MCP; disconnecting while an agent owns a running task creates
an automatic handoff checkpoint.

The generated files are:

| File | Purpose |
|---|---|
| `.mcp.json` | Claude Code and other MCP clients |
| `.vscode/mcp.json` | MCP in VS Code |
| `.cursor/mcp.json` | MCP in Cursor |
| `.gemini/settings.json` | MCP in Gemini CLI |
| instruction files | Agent behavior rules, written by `agentbrain rules` |

Use `agentbrain connect --only <ids>` to configure selected targets. The
operation is repeatable and preserves unrelated configuration.

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

`status` and the brief number the remaining items and known failures, so
`--done 2` completes remaining item 2 and `--fixed 1` clears failure 1.

When the agent exits without handing off (usage limit, crash, Ctrl-C, closed
terminal), AgentBrain records a handoff with the reason. Built in: `claude`,
`codex`, `gemini`, `cursor` (cursor-agent), `copilot` (Copilot CLI), `aider`.
VS Code's GitHub Copilot agent mode is also available as a detached launcher:

```bash
agentbrain run vscode
```

This opens the project in VS Code, starts Copilot agent mode, and attaches the
continuation brief as a file. VS Code owns the task after its launcher exits;
the agent records progress and hands off through AgentBrain.
Anything else:

```bash
agentbrain run --agent my-agent -- my-agent-cli --message {prompt}
```

### Automatic capture

To record a checkpoint after every successful commit while the active task is
running, install the Git hook:

```bash
agentbrain hooks install
```

The hook respects Git's `core.hooksPath` and preserves existing hook content.
It can be removed with `agentbrain hooks uninstall`. AgentBrain failures never
fail or delay a commit.

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

### Parallel agents: one worktree per task

```bash
agentbrain task create "Add prune command" --worktree   # .agentbrain/worktrees/<id>, branch agentbrain/<id>
agentbrain run vscode <task-id>                         # the agent works only in that folder
agentbrain worktree merge <task-id>                     # merge the branch back, remove the worktree
```

Every worktree shares the project's AgentBrain state, and commands, the MCP
server and the commit hook inside a worktree apply to that worktree's task.
Git state, changed files and stall warnings are per task, so two agents on two
tasks never see, or trip over, each other's edits. `worktree merge` stops on
conflicts and leaves them for you; `worktree remove` refuses to discard
uncommitted work unless you pass `--force`.

### When an agent goes quiet

`agentbrain status` (and every brief) warns when:

- the agent that owns a running task has shown no activity for 10 minutes —
  no AgentBrain updates and no file changes; it may have stopped or be waiting
  on an approval prompt;
- an agent keeps changing files but hasn't recorded progress for 10 minutes;
- files changed after a handoff but no agent has taken the task over.

Set `"stallMinutes"` in `.agentbrain/project.json` to change the threshold.

### Everything else

```bash
agentbrain status                 # active task, progress, last checkpoint, stall warnings
agentbrain checkpoint             # snapshot without stopping
agentbrain log                    # timeline of agent sessions and checkpoints
agentbrain worktree list          # task worktrees and their branches
agentbrain prune [task-id]        # remove old checkpoints (use --keep N, --all, or --dry-run)
agentbrain connect                # configure MCP, rules, and the Git hook
agentbrain doctor                 # check setup and print fixes for anything missing
agentbrain mcp                    # run the MCP server (normally started by an agent)
agentbrain hooks install          # install automatic post-commit checkpoints
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
  CLIs. MCP is tested with stub clients. `npm test` runs it all.
- **Verified live with GitHub Copilot in VS Code:** after `agentbrain connect`,
  a brand-new chat given only the word "continue" called `agentbrain_brief`,
  picked up the task another agent had handed off, recorded its progress and
  moved it to review. Other agents' MCP configs are written but not yet tried
  live.
- **Not built yet:** headless execution over ACP, worktree isolation, agent
  routing. See [`SPEC.md`](SPEC.md) for the spec and roadmap.

## Development

```bash
npm test         # type-checks, then runs unit + end-to-end tests
npm run smoke    # full CLI workflow in a throwaway repo
```

## License

MIT
