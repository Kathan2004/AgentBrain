# Changelog

## 0.13.0
- **Console**: bare `agentbrain` opens a prompt-driven console. Type a task; it gets its own worktree and goes to the best-placed agent (Shift+Tab or `@claude`/`@codex`/`@copilot`/`@any` to choose), its work streams in live, and the result comes back for `/approve` or `/changes`. `agentbrain top` is the old live view
- **Agent choice per task**, with reasons: who is free, approvals and send-backs in this project, reputation, usage limits, crashes, preferences
- **Background Claude Code and Codex**: `agentbrain run claude-code|codex --print` (`claude -p`, `codex exec`, including the copy of Claude Code bundled with the Claude desktop app); sign-in is detected
- **Pull work**: `@any` leaves a task for the next MCP agent you open (Claude app, Cursor, VS Code extensions)
- **Control plane**: `agentbrain on`/`off` connects every agent, streams Claude Code activity through hooks, and runs the web control room (prompt box, what needs you, what is in progress, activity, brain graph, settings)
- **Who decides**: a lead agent or a review council with sealed, reputation-weighted votes and a quorum; AgentBrain runs `agentbrain checks` itself and flags claims the evidence contradicts (false "tests pass", no changes, files that don't exist, dissent)
- **Agents talk and delegate**: `agentbrain_message` / `agentbrain message`, and `agentbrain_delegate` to split work into linked subtasks with their own worktree, checks and review
- **Memory palace**: `.agentbrain/vault` is an Obsidian vault (onboarding, lessons, decisions, code map, daily log, agent-written memory); `agentbrain_recall` / `agentbrain recall` and `agentbrain_remember`
- The control room's Brain tab draws the real vault, notes and `[[links]]` read from disk, like Obsidian's graph view: rooms by colour, zoom and pan, labels that appear as you zoom, notes open in place with clickable links, and buttons to open the folder or the vault in Obsidian
- Approving merges alongside someone else's uncommitted work unless the same files are touched
- Never sets itself up outside a Git repository or in your home folder
- Windows: PATHEXT-aware lookup, `.cmd` shims (arguments escaped twice, as batch files re-parse them), prompts on stdin, forward-slash paths in feeds, per-OS VS Code and browser; Windows CI job

## 0.12.0
- `task update --drop` (and MCP `drop`): remove wrong or duplicate to-do items without marking them done
- The task queue shows in the live terminal view and the web page
- `worktree prune --branches` recognizes squash-merged branches

## 0.11.0
- `agentbrain notify`: desktop notifications when a task reaches review, done, blocked, failed or handoff, or stalls
- `--json` for `status`, `task list`, `log` and `route`
- `agentbrain init --worktrees` / `worktreeByDefault`: every new task gets its own worktree (`--no-worktree` to opt out)
- Task objectives may start with a dash

## 0.10.0
- `agentbrain run vscode --here`: send a task to the Copilot chat you already have open, without opening a window
- `agentbrain queue`: line up tasks for one agent; `queue run` hands them over one after another as each settles
- `agentbrain worktree prune`: clean up worktrees and merged branches of finished tasks
- Briefs list the commits made on the task
- MCP tools `agentbrain_log` (timeline) and `agentbrain_route` (who should take the task next)
- `agentbrain doctor` flags leftover worktrees and broken queue entries
- Commit hook: commits outside a task's worktree are no longer recorded against it
- CI on GitHub Actions (Linux and macOS, Node 20 and 22)

## 0.9.0
- Live terminal view (`agentbrain` with no arguments) and local web view (`agentbrain ui`)
- Background headless runs: `--detach`, `--linger`, `attach`, `stop`; messages become the agent's next turn

## 0.8.0
- `agentbrain route`: suggestions grounded in usage limits, track record and preferences
- `agentbrain export`: one portable Markdown file with brief and history

## 0.7.0
- Headless runs over the Agent Client Protocol, confined to the task's worktree with a permission policy

## 0.6.0
- One Git worktree per task (`--worktree`, `worktree add | merge | remove | list`), `agentbrain prune`

## 0.5.0
- `agentbrain log`, stall warnings, `agentbrain doctor`

## 0.4.0
- MCP server: live task state in every agent's new chat; `agentbrain connect`; commit hook

## 0.3.0
- VS Code agent mode adapter

## 0.2.0
- Launch terminal agents with the brief, auto-handoff on exit, instruction files, secret redaction

## 0.1.0
- Task state, Git-aware checkpoints, Markdown handoffs, resume
