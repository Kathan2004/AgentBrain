# Changelog

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
