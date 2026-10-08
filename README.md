# AgentBrain

[![CI](https://github.com/Kathan2004/AgentBrain/actions/workflows/ci.yml/badge.svg)](https://github.com/Kathan2004/AgentBrain/actions/workflows/ci.yml)

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

### Five-minute walkthrough

Follow these steps from the root of the project you want agents to work on.

1. **Install AgentBrain.**

   ```bash
   npm install
   npm run build
   npm link
   ```

   These install dependencies, build the CLI, and put `agentbrain` on your
   `PATH`. You should see a successful TypeScript build and be able to run
   `agentbrain --help`.

2. **Initialize the project.**

   ```bash
   agentbrain init
   ```

   This creates the local `.agentbrain/` state directory. You should see a
   confirmation that the project is initialized.

3. **Connect your coding agents.**

   ```bash
   agentbrain connect
   ```

   This configures MCP, writes agent instructions, and installs the Git hook.
   You should see the targets that were configured and the files that were
   written.

4. **Create a task in its own worktree.**

   ```bash
   agentbrain task create "Implement OAuth login" --worktree
   ```

   This creates and activates a task with an isolated Git worktree. You should
   see the task ID, its `agentbrain/<task-id>` branch, and its worktree path.

5. **Start the first agent.**

   ```bash
   agentbrain run claude
   ```

   This launches Claude with the task brief and asks it to record progress as
   it works. You should see Claude working in the task's worktree; in Copilot
   or Cursor, open the connected project and say `continue` instead.

6. **Let AgentBrain capture the handoff.**

   ```bash
   agentbrain status
   ```

   When the agent exits because it finishes, reaches a usage limit, or stops,
   AgentBrain writes a handoff checkpoint automatically. You should see the
   task's progress, stop reason, and next action in the status output.

7. **Route the task to another agent.**

   ```bash
   agentbrain route
   agentbrain run codex
   ```

   The first command suggests the next agent and explains why; the second
   starts it with the saved brief. You should see the new agent continue from
   the previous checkpoint rather than starting from scratch.

8. **Watch the task live.**

   ```bash
   agentbrain
   ```

   This opens the live terminal view of tasks, agents, checkpoints, and diffs.
   You should see the active task and its current status update as work
   progresses.

9. **Finish by merging the worktree.**

   ```bash
   agentbrain worktree merge <task-id>
   ```

   This merges the completed task branch into the project and removes its
   worktree. You should see the merge result and a clean-up confirmation.

### How it works

AgentBrain persists coordination state alongside the project:

```text
.agentbrain/
├── project.json
├── tasks/<task-id>/task.json
├── tasks/<task-id>/checkpoints/<checkpoint-id>.{json,md}
└── agents/<agent-id>/sessions/<session-id>.{json,prompt.md}
```

The same state reaches agents through three integration paths:

- **MCP:** `agentbrain connect` configures clients to read briefs, update
  progress, checkpoint, and hand off through the MCP server.
- **Instruction files:** `agentbrain rules` writes the protocol into files such
  as `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md`.
- **Launching agents:** `agentbrain run <agent>` starts a terminal agent with
  the current brief and records an automatic handoff when it exits.

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
can read the brief and timeline, get routing suggestions, update progress,
checkpoint, hand off, create a task, and list tasks through MCP. Routing only
suggests; the developer decides, and disconnecting while an agent owns a running
task creates an automatic handoff checkpoint.

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
`--done 2` completes remaining item 2, `--drop 1` removes a wrong or duplicate item without marking it finished, and `--fixed 1` clears failure 1.

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

`agentbrain run vscode <task-id> --here` sends the task to the Copilot chat you
already have open instead of opening the task's folder in a new window; the
message tells Copilot the exact directory to work in.

### Parallel agents: one worktree per task

`agentbrain init --worktrees` (or `"worktreeByDefault": true` in
`.agentbrain/project.json`) gives every new task its own worktree; pass
`--no-worktree` to opt a single task out.

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

### Headless: no window at all

```bash
agentbrain run claude-code <task-id> --headless --timeout 30
```

Runs an agent that speaks the Agent Client Protocol (`claude-code-acp`,
`gemini --experimental-acp`, `codex-acp`, or any ACP command after `--`) with
no UI, in the task's own worktree. AgentBrain answers the agent's requests on
your behalf: file reads and writes only inside that worktree; edits allowed,
but shell commands, deletes and network calls rejected unless you pass
`--allow read,edit,execute,...`. The agent records progress through
AgentBrain's MCP server, gets "continue" while it is making progress
(`--max-turns`, default 3), and the run always ends with the task in review or
handed off, plus a transcript you can read afterwards.

Tested with a stand-in ACP agent; not yet run against the real ones.

### Live web dashboard

```bash
agentbrain ui                 # open the local task dashboard on port 4747
agentbrain ui --port 5050     # choose a port (a busy default port is replaced automatically)
```

The dashboard shows every task, agent progress, diffs, timelines, and live
headless transcripts. It runs on localhost and requires its private URL token.

### When an agent goes quiet

`agentbrain status` (and every brief) warns when:

- the agent that owns a running task has shown no activity for 10 minutes —
  no AgentBrain updates and no file changes; it may have stopped or be waiting
  on an approval prompt;
- an agent keeps changing files but hasn't recorded progress for 10 minutes;
- files changed after a handoff but no agent has taken the task over.

Set `"stallMinutes"` in `.agentbrain/project.json` to change the threshold.

### Live view

```bash
agentbrain notify              # desktop notifications for settled or stalled tasks
agentbrain notify --print      # print notifications instead of using the desktop
```

The notifier runs until stopped with `Ctrl-C` and reports tasks that move to
review, done, blocked, failed, or handoff, plus newly detected stall warnings.

Run `agentbrain` with no arguments for a live terminal view of every task and
agent: status lights (running, stalled, handed off, in review), the brief, the
uncommitted diff in each task's worktree, the timeline, routing suggestions,
and the live output of background (headless) agents. Select with the arrow
keys or the mouse. `o` opens the task's folder in VS Code without stopping
anything; `m` sends a message to a background agent (it becomes the agent's
next turn in the same session); `s` stops it.

### Everything else

```bash
agentbrain status                 # active task, progress, last checkpoint, stall warnings
agentbrain status --json          # machine-readable JSON for status, task list, log, or route
agentbrain checkpoint             # snapshot without stopping
agentbrain log                    # timeline of agent sessions and checkpoints
agentbrain route [task-id]        # which agent should take the task next, with reasons
agentbrain queue add <task-id>... # line up tasks for one agent
agentbrain queue list             # what's queued (queue remove <task-id> to drop one)
agentbrain queue run vscode --here # hand queued tasks to the agent one after another
agentbrain attach <session-id>    # watch a background (headless) agent live and message it
agentbrain stop <session-id>      # stop a background agent; its task is handed off
agentbrain export [task-id]       # export a portable Markdown brief and history
agentbrain worktree add [task-id] # give a task its own Git worktree
agentbrain worktree remove [task-id] # remove a task worktree
agentbrain worktree list          # task worktrees and their branches
agentbrain worktree prune         # clean up worktrees of finished, merged tasks (--branches, --dry-run)
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
