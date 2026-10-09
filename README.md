# AgentBrain

[![CI](https://github.com/Kathan2004/AgentBrain/actions/workflows/ci.yml/badge.svg)](https://github.com/Kathan2004/AgentBrain/actions/workflows/ci.yml)

> One project. Any coding agent. No lost context.

AgentBrain is a local-first continuity layer for AI coding agents. It keeps the
execution state of a software task — objective, progress, decisions, failures,
Git state, next action — with the repository, so the task can move from one
agent to another without starting the conversation over.

Git tells you what the code looks like. AgentBrain tells the next agent what was
happening and what to do next.

Switch it on from any terminal, even inside an agent session, and it becomes the
control room beside your agents: it shows every agent at work, keeps the shared
memory, and decides whose work counts, by one lead agent or by a council that
votes and checks the evidence itself.

AgentBrain is **not** an IDE, a model provider, or a replacement for Git. It
never commits on its own (merging an approved task's branch is the one Git
write it makes, and only when you have set reviewers), and never stores file
contents.

## Install

```bash
git clone <this repo> && cd agentbrain
npm install
npm run build
npm link          # puts `agentbrain` on your PATH
agentbrain doctor # checks the installation and project integration
```

Requires Node 20+ and Git.

## The console

```bash
cd your-project
agentbrain
```

Opens the AgentBrain console, built like an agent CLI: a prompt box, slash
commands, and a live transcript. What you type is **delegated**: it becomes a
task with its own worktree, your worker agent picks it up (Copilot in the VS
Code chat you already have open, or a headless agent), and its edits, commands
and progress stream into the console. When it finishes, the result comes back
for review with AgentBrain's own checks: `/approve` merges it, `/changes <what
to fix>` sends it back. `/help` lists the rest (`/status`, `/review`,
`/continue`, `/worker`, `/lead`, `/council`, `/checks`, `/dashboard`).

AgentBrain only sets itself up inside a project (a Git repository), never in
your home folder. `agentbrain top` is the older full-screen live view.

## Control plane

```bash
agentbrain on                  # from any terminal in a project, or `! agentbrain on` inside Claude Code
```

One idempotent step: it initializes the repo if needed, connects every agent to
AgentBrain over MCP, streams Claude Code's prompts, edits and commands into the
activity feed (hooks in `.claude/settings.local.json`), installs the commit
hook, and opens the **control room** in your browser, beside your terminal:

- **Home**: a prompt box to delegate from the browser, what **needs you**
  (results to review, with checks, flags and votes), and what is **in
  progress**, each task with its stage (delegated, working, checks, review,
  done) and its latest activity.
- **Activity**: the live feed of prompts, edits, commands, commits, progress,
  decisions, handoffs and verdicts, from every agent.
- **Brain**: the shared memory as a graph of tasks, agents, decisions, files and
  flags (also written as an Obsidian vault in `.agentbrain/vault`).
- **Settings**: who new tasks go to, who decides, and the checks.

`agentbrain off` stops streaming and closes the control room; state is kept.
Details: [docs/control-plane.md](docs/control-plane.md).

### Who decides: a lead or a council

```bash
agentbrain lead claude-code                       # one agent reviews everyone else's work
agentbrain council claude-code codex gemini cursor --quorum 0.67
agentbrain checks "npm test" "npx tsc --noEmit"   # AgentBrain runs these itself on every result
agentbrain review                                 # what is waiting, with claims, diff, checks, flags, votes
agentbrain review <task-id> --approve             # or --changes "<what to fix>"
```

With reviewers set, an agent that finishes a task doesn't close it: the task
waits in review. A **lead** approves or sends it back. A **council** votes:

- **Evidence first.** AgentBrain runs your checks in the task's folder itself.
  Failing checks block approval whatever the votes say.
- **Sealed votes.** Reviewers can't see each other's votes until they have
  voted, so they judge the work, not each other.
- **Reputation as stake.** Votes are weighted by each agent's track record:
  agreeing with outcomes earns weight, dissent and false claims cost it.
- **Quorum.** A result passes with the quorum's share of the weight (default
  two thirds). With equal weights, n reviewers survive ⌊n/3⌋ broken,
  compromised or hallucinating members: 4 tolerate 1, 7 tolerate 2.
- **Flags.** Claims that the evidence contradicts are shown on the result and in
  the brain: "tests pass" when AgentBrain's run failed, "done" with no changes,
  files that don't exist (in the work or in a review), and votes against the
  consensus.

Approval merges the task's worktree branch and marks it done. Changes become
the task's remaining items and hand it back. Your verdict, from the CLI or the
control room, always decides (recorded as an override).

### Agents talking to each other

Agents working on the same project at the same time can coordinate through
AgentBrain: "my uncommitted change to README.md blocks your merge", "I'm
editing the API, hold off on the client", "can you review this?".

```bash
agentbrain message vscode "hold off on page.ts, I'm editing it"   # or: all, claude-code, codex…
agentbrain inbox                                                    # messages for you
```

Agents send with the `agentbrain_message` MCP tool and receive messages in
their next AgentBrain tool result; Claude Code also gets them through its hooks
(including just before it stops), and Copilot gets them in its VS Code chat when
it is idle. In the console: `/message <agent|all> <text>`.

### The memory palace (an Obsidian vault)

`.agentbrain/vault` is a real Obsidian vault, kept current by AgentBrain: open
the folder in Obsidian and the graph view shows the project's memory, coloured
by room.

- **Onboarding**: the first note any agent reads, new or returning: how work
  happens here, who reviews, the checks, and what to read next.
- **Lessons**: what reviewers sent back, claims that didn't match the evidence,
  known failures. New sessions get the latest lessons in their first context.
- **Agents**, **Tasks**, **Decisions** (one note per decision, linked to its
  task and agent), **Code map** (files the agents changed and which tasks did),
  **Daily log**.
- **Memory**: lasting notes agents save with `agentbrain_remember`, plus
  anything you write anywhere in the vault. AgentBrain never overwrites them.

Agents search all of it with `agentbrain_recall`; you can too:

```bash
agentbrain recall "how do we handle auth tokens"
```

### Choosing the agent

Each prompt goes to the agent best placed to do it right now: who is free,
whose results were approved or sent back in this project, reputation, recent
usage limits and crashes, and your preferences. The console shows the pick and
the reasons (Shift+Tab switches, `@claude …` / `@codex …` / `@copilot …` /
`@any …` at the start of a prompt overrides). Agents AgentBrain can start
itself: Copilot in your open VS Code chat, Claude Code (`claude -p`, including
the copy inside the Claude desktop app) and Codex (`codex exec`), with no
window (`agentbrain run claude-code|codex [task] --print`), and ACP agents.
Everything else that speaks MCP (the Claude app, Cursor, Windsurf, the Claude
Code / Codex / Cline extensions in VS Code) can pull work: `@any` leaves the
task waiting, and the next agent you open on the repo is told about it.

Claude Code as a reviewer is asked to review automatically: when it finishes a
turn with results waiting, its stop hook hands it the review queue once per
result. Other agents see the queue in their MCP instructions and tools.

Limits, stated plainly: reviewers built on the same model can share the same
blind spot, so mix vendors in a council. Flags catch claims that can be checked
mechanically, not every wrong answer.

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
agentbrain ui                 # run the control room in this terminal (agentbrain on runs it in the background)
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
agentbrain top                 # full-screen live view of every task and agent
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
agentbrain on                     # enable AgentBrain and start the control room
agentbrain off                    # stop the control room and activity hooks
agentbrain lead <agent-id>        # set the reviewing lead agent
agentbrain council <agent-id>...  # configure a reviewing council
agentbrain checks <command>...    # configure checks for submitted work
agentbrain review [task-id]       # inspect or decide pending reviews
agentbrain doctor                 # check setup and print fixes for anything missing
agentbrain vault                  # regenerate the Obsidian Markdown vault
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
