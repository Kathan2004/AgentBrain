# AgentBrain

> One project. Any coding agent. No lost context.

AgentBrain is a local-first continuity layer for AI coding agents. It preserves project, task, and agent execution state so an active software task can move between coding agents without reconstructing the entire conversation.

## Current scope

V0.1 focuses on:

- project/task/agent state
- Git-aware checkpoints
- portable handoff context
- `init`, `status`, `handoff`, and `resume`
- an adapter boundary for coding agents

AgentBrain is **not** an IDE, model provider, autonomous swarm, or replacement for Git.

## Quick start

```bash
npm install
npm run build
npm link            # optional: puts `agentbrain` on your PATH

cd your-project     # must be a Git repository
agentbrain init
agentbrain task create "Implement OAuth login"

# Agent A records progress as it works
agentbrain task update --agent claude-code --done "OAuth callback" \
  --todo "Refresh-token rotation" --decision "Use httpOnly cookies" \
  --next "Implement refresh-token rotation"

# Agent A stops (usage limit, session end, ...)
agentbrain handoff --reason "usage limit"

# Agent B picks up: prints the handoff and records the new session
agentbrain resume --agent codex
```

Paste the `resume` output into the next agent, or let the agent run the
command itself.

## Development

```bash
npm test         # type-checks, then runs unit + end-to-end CLI tests
npm run smoke    # runs the full CLI workflow in a throwaway repo
```

## Architecture

```text
Developer
   |
   v
AgentBrain CLI
   |
   +-- Project State
   +-- Task State
   +-- Agent State
   +-- Checkpoints
   +-- Git Integration
   |
   +-- Agent Adapters
          |
          +-- ACP
          +-- Native adapters
          +-- Generic adapters
```

## First milestone

Make this workflow reliable:

```text
Agent A works
   -> checkpoint
   -> AgentBrain creates portable continuation context
   -> Agent B resumes
   -> Agent B can understand the task without the original conversation
```

See [`SPEC.md`](SPEC.md) for the V0.1 specification.
