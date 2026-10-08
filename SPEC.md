# AgentBrain V0.1 Specification

## 1. Problem

AI coding agents maintain fragmented context. When a developer changes agents because of usage limits, failure, preference, or task specialization, the developer often has to reconstruct:

- what the task was
- what has already been changed
- why architectural decisions were made
- what failed
- what remains
- what the next agent should do

AgentBrain makes this state portable.

## 2. Product thesis

AgentBrain is a local-first project execution-state and handoff layer for AI coding agents.

It does not attempt to replace coding agents. It makes their work transferable.

## 3. Goals

### V0.1 goals

1. Initialize an AgentBrain-enabled repository.
2. Represent project, task, and agent state.
3. Capture a Git-aware checkpoint.
4. Generate a portable handoff document.
5. Resume a task using the handoff state.
6. Keep the state human-readable and Git-friendly.
7. Keep agent integrations behind adapters.

## 4. Non-goals

V0.1 will not:

- host or train AI models
- provide an IDE
- provide a cloud service
- run an autonomous agent swarm
- implement a new agent communication protocol
- require a vector database
- attempt to synchronize complete agent conversation histories
- automatically merge arbitrary concurrent agent changes

## 5. Terminology

### Project State

Durable information about the repository:

- architecture
- conventions
- constraints
- important decisions

### Task State

The current development objective:

- objective
- subtasks
- progress
- blockers
- verification

### Agent State

Information specific to an agent session:

- agent identifier
- session identifier
- current action
- modified files
- stopping reason
- checkpoint

### Checkpoint

A snapshot of task execution state designed to allow another agent to continue.

### Handoff

A checkpoint packaged as actionable continuation context for another agent.

## 6. State machine

```text
IDLE
  |
  v
RUNNING
  |
  +----> CHECKPOINT ----> HANDOFF ----> RUNNING
  |
  +----> REVIEW --------> DONE
  |
  +----> BLOCKED
  |
  +----> FAILED
```

### State meanings

- `IDLE`: no active execution.
- `RUNNING`: an agent is actively working.
- `CHECKPOINT`: execution state is being captured.
- `HANDOFF`: state is ready for another agent.
- `REVIEW`: implementation awaits verification.
- `BLOCKED`: progress cannot continue without an external decision/input.
- `FAILED`: execution ended unsuccessfully.
- `DONE`: task is verified complete.

## 7. Directory layout

```text
.agentbrain/
├── project.json
├── tasks/
│   └── <task-id>/
│       ├── task.json
│       └── checkpoints/
│           └── <checkpoint-id>.json
└── agents/
    └── <agent-id>/
        └── sessions/
            └── <session-id>.json
```

## 8. Checkpoint schema

A checkpoint must contain:

- schema version
- checkpoint ID
- task ID
- timestamp
- repository revision
- active agent
- current status
- completed work
- remaining work
- modified files
- decisions
- known failures
- verification results
- next recommended action

Example:

```json
{
  "schemaVersion": "0.1",
  "checkpointId": "cp-001",
  "taskId": "task-001",
  "status": "handoff",
  "agent": {
    "id": "claude-code",
    "sessionId": "abc123"
  },
  "git": {
    "head": "abc1234",
    "dirty": true
  },
  "progress": {
    "completed": ["OAuth callback"],
    "remaining": ["refresh-token rotation"]
  },
  "nextAction": "Implement refresh-token rotation"
}
```

## 9. Handoff rules

A handoff must be deterministic enough that a second agent can act without the original conversation.

The generated handoff should prioritize:

1. objective
2. current state
3. completed work
4. remaining work
5. constraints
6. decisions
7. failures
8. relevant files
9. verification
10. next action

The handoff should avoid copying irrelevant conversation history.

## 10. Agent adapter interface

Conceptually:

```ts
interface AgentAdapter {
  id: string;
  capabilities(): AgentCapabilities;
  start(context: AgentContext): Promise<AgentSession>;
  resume(context: AgentContext): Promise<AgentSession>;
  stop(session: AgentSession): Promise<void>;
}
```

The adapter layer must not leak provider-specific concepts into the core state model.

Where an interoperability protocol such as ACP is available, AgentBrain should prefer the standard protocol over a proprietary integration.

### Implemented integrations (v0.2)

AgentBrain integrates with agents in two ways, neither of which requires
vendor-specific code in the core:

1. **Process adapters** (`agentbrain run <agent>`): the agent's own terminal
   UI is launched on the user's terminal with the AgentBrain continuation brief
   as its opening message. Built in: Claude Code, Codex CLI, Gemini CLI, Cursor
    CLI, Copilot CLI, Aider, and VS Code Copilot agent mode (`vscode`). The VS
    Code launcher opens the project with `code`, attaches the brief with
    `--add-file`, and is detached: its successful exit does not trigger an
    automatic handoff. Any other CLI: `agentbrain run --agent <id> -- <cmd>
    {prompt}`. The agent process gets `AGENTBRAIN_AGENT`, `AGENTBRAIN_SESSION`,
    `AGENTBRAIN_TASK`, `AGENTBRAIN_ROOT` and `AGENTBRAIN_PROMPT_FILE`.
2. **Instruction files** (`agentbrain rules`): for agents that live inside an
   IDE (Cursor, Copilot in VS Code, Windsurf, ...) and cannot be launched by
   AgentBrain. `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
   `.cursor/rules/agentbrain.mdc` and `.github/copilot-instructions.md` tell
   the agent to `resume`, record progress with `task update`, and `handoff`.

In both cases the agent writes state back through the CLI, so the next switch
is as lossless as the current one.

3. **MCP server** (`agentbrain connect`): a stdio MCP server gives compatible
  agents live access to the project state. At initialization it provides the
  current brief as server instructions, so a new chat can continue without a
  pasted handoff. It exposes these tools:

  - `agentbrain_brief`
  - `agentbrain_log` (read-only task timeline)
  - `agentbrain_route` (read-only routing suggestions; the developer decides)
  - `agentbrain_update`
  - `agentbrain_handoff`
  - `agentbrain_checkpoint`
  - `agentbrain_create_task`
  - `agentbrain_list_tasks`

  Not every client shows server instructions to the model, so the task in
  progress (id, objective, next action) is also embedded in the
  `agentbrain_brief` tool description, which every client does show. A bare
  "continue" must never start a new task: `agentbrain_create_task` refuses while
  another task is unfinished and returns that task's brief instead, unless the
  agent passes `confirm_new: true`. (Found in the first live run: Copilot
  turned "continue" into a new task.)

  The first write from a connection claims the task for that agent. If the
  connection closes while it still owns a running task, the server writes a
  handoff checkpoint. `agentbrain connect` also writes the MCP registrations
  for supported clients, the instruction files, and the post-commit hook.

4. **Headless ACP** (`agentbrain run <agent> --headless`): AgentBrain is the
   Agent Client Protocol client for an ACP agent and runs it with no UI. ACP is
   used only here: interactively, developers already have a UI (the agent's
   own TUI or their IDE), and AgentBrain must not become an editor.

   - The task gets its own worktree unless `--in-place`; the agent's `cwd` is
     that worktree and `fs/read_text_file` / `fs/write_text_file` are confined
     to it. No terminal capability is offered.
   - `session/request_permission` is answered by policy: `read`, `edit`,
     `search`, `think` allowed by default; other kinds rejected unless listed
     in `--allow`.
   - `session/new` passes AgentBrain's MCP server with the run's identity
     (`agentbrain mcp --root <worktree> --agent <id> --session <id>`). That
     server does not hand off on disconnect; the runner does, with the stop
     reason.
   - Prompts: brief + headless rules, then `continue` while the agent keeps
     recording progress, up to `--max-turns` (default 3). `--timeout` sends
     `session/cancel` and stops the agent.
   - A run always ends with the task in review/done or handed off, and a
     transcript at `.agentbrain/agents/<id>/sessions/<session>.log`.

## 11. Git behavior

V0.1 treats Git as the source of truth for source code.

AgentBrain records Git metadata in checkpoints but does not replace Git.

A checkpoint should record:

- HEAD commit
- branch
- dirty/clean state
- relevant changed files

V0.1 should not automatically commit user code.

### Automatic commit checkpoints

`agentbrain hooks install` installs a marked `post-commit` block in Git's hooks
directory, including the configured `core.hooksPath`, and preserves unrelated
hook content. Reinstalling is idempotent; `agentbrain hooks uninstall` removes
only the marked block. When the project has an active running task, the hook
invokes `agentbrain hook post-commit`, which writes a `checkpoint` with reason
`commit <short-sha>: <subject>`. If AgentBrain is unavailable, uninitialized,
or the task is not running, it does nothing. Hook failures are always ignored so
commits cannot fail or be delayed by AgentBrain.

## 12. CLI

### Initialize

```bash
agentbrain init
```

### Status

```bash
agentbrain status
```

### Create task

```bash
agentbrain task create "Implement OAuth authentication"
```

### List / update tasks

```bash
agentbrain task list
agentbrain task update --agent claude-code --done "OAuth callback" \
  --todo "Refresh-token rotation" --decision "Use httpOnly cookies" \
  --failure "Expired token test fails" --next "Implement refresh-token rotation"
```

`task update` is how an agent (or the developer) records progress. `--done`,
`--todo`, `--decision`, `--failure` and `--blocker` are repeatable. `--done`
moves a matching item out of `remaining`. `--status` sets any task status.

### Checkpoint / handoff

```bash
agentbrain handoff [task-id] [--agent <id>] [--session <id>] [--reason <text>]
```

Writes `<checkpoint-id>.json` and `<checkpoint-id>.md` under the task's
`checkpoints/`, marks the task `handoff`, and closes the agent session record.

### Resume

```bash
agentbrain resume [task-id] [--agent <id>] [--session <id>]
```

Prints the continuation brief: the live task and Git state, attributed to the
last handoff, plus instructions for recording progress. With `--agent`, the new agent takes over: the task
becomes `running` and a session record is opened under `agents/`.

All commands except `init` work from any subdirectory of the project.

### Run an agent

```bash
agentbrain run <agent> [task-id]                       # claude-code, codex, gemini, cursor, copilot, aider, vscode
agentbrain run [task-id] --agent <id> -- <cmd> {prompt}  # anything else
```

Takes over the task, launches the agent with the continuation brief, and when
the agent exits writes a handoff checkpoint unless the agent already handed
off or moved the task to `review`/`done`. Detached launchers such as `vscode`
leave the task running after a successful launcher exit; the launched agent
owns progress and handoff from that point.

### Checkpoint without stopping

```bash
agentbrain checkpoint [task-id] [--reason <text>]
```

### Agents, sessions and instruction files

```bash
agentbrain agents        # installed terminal agents + recorded sessions
agentbrain rules         # write agent instruction files (--only cursor,copilot)
agentbrain task use <id> # switch the active task
```

## 13. Security principles

AgentBrain may process source code and agent context.

Therefore:

- state is local by default
- no source code is uploaded without explicit user configuration
- credentials must never be written to state
- environment variables and secret files must be excluded
- generated handoffs must be reviewed before being sent to another external agent
- `.agentbrain` should support secret redaction rules

Implemented: all free text (objective, progress items, decisions, failures,
blockers, next action, stop reasons) is redacted before it is stored. Built-in
patterns cover private keys, AWS/GitHub/OpenAI/Anthropic/Slack/Google keys,
JWTs, `password=`-style assignments and credentials in URLs. Add project
patterns as `"redactPatterns": ["regex", ...]` in `.agentbrain/project.json`.
File *contents* are never read or stored — only changed file paths.

## 14. V0.1 acceptance tests

V0.1 is successful when:

1. `agentbrain init` creates a valid state directory.
2. A task can be created.
3. Git state is captured.
4. A checkpoint can be generated.
5. A handoff can be generated from a checkpoint.
6. A fresh process can read the handoff.
7. A second agent adapter can consume the resulting context.
8. No secrets are included in generated state.
9. Existing source code is not modified by checkpoint creation.
10. The entire workflow works offline except for the external agent itself.

## 15. Roadmap

### V0.1 — done
Portable state + handoff: init, tasks, Git-aware checkpoints, Markdown handoff,
resume, secret redaction.

### V0.2 — done
First agent integrations: `agentbrain run` process adapters, `agentbrain rules`
instruction files for IDE agents, agent session records.

### V0.3 — partly done
Automatic checkpointing. Done: auto-handoff when an agent launched by `run`
exits without handing off (usage limit, crash, Ctrl-C). Planned: checkpoint
after test runs and on a timer. MCP server integration is done and verified
live with Copilot in VS Code; Git post-commit checkpoints are done.

### V0.5 — done
Stall warnings (no activity, unrecorded work, unclaimed handoffs), `agentbrain
log` timeline, `agentbrain doctor`, MCP live refresh (tools/list_changed),
compact briefs for long histories.

Known limitation: file activity is per working tree, not per task (fixed in
V0.6 for tasks with their own worktree).

### V0.6 — done
Git worktree per task (`--worktree`, `worktree add|merge|remove|list`) with
shared state; per-task Git state, stall detection, task resolution, commit
hook and agent launch; `agentbrain prune`.

### V0.7 — done
Headless runs over ACP; README/CLI docs guard test.

### V0.8 — done
`agentbrain route` (suggestions from usage limits, track record and
preferences; task status history), `agentbrain export`.

### V0.9 — done
Live views: `agentbrain` (terminal: keyboard and mouse) and `agentbrain ui`
(local web page: localhost only, per-run token, Host/Origin checks), both
rendering one snapshot of tasks, sessions, per-worktree diffs, stall
warnings and headless transcripts. Background headless runs (`--detach`,
`--linger`), `attach`, `stop`, and developer messages delivered as the
agent's next turn in the same ACP session.

### Next
Trying headless runs against real ACP agents.

### V1.0
Stable project-state specification and extensible agent ecosystem.
