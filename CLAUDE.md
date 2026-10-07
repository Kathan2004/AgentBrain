<!-- agentbrain:start -->
## AgentBrain: task continuity across coding agents

This project uses AgentBrain to move tasks between AI coding agents. Another agent
may have worked on the current task before you, and another may continue after you.

If the `agentbrain_*` MCP tools are available, use them (agentbrain_brief,
agentbrain_update, agentbrain_handoff) instead of the commands below.

**When the developer asks you to work on, continue or resume the current task**
(a bare "continue", "resume" or "keep going" means exactly this, even mid-conversation:
other agents may have changed the task since your earlier messages, so AgentBrain, not
the chat history, is the source of truth):
run this first and treat its output as your brief:

    agentbrain resume --agent claude-code

It shows the objective, completed and remaining work, decisions, known failures,
the Git state and the next action. Continue from there; do not ask the developer
to re-explain. If there is no active task and the developer gave you a new one, run
`agentbrain task create "<objective>"` first.

**While working**, after each meaningful step (you may be cut off without warning):

    agentbrain task update --done "<finished step>" --todo "<new step>" --decision "<decision and why>" --failure "<what failed>" --next "<next action>"

- `--done` / `--fixed` take the item's text or any unique part of it.
- Objective complete and verified: `agentbrain task update --status review --next "Review the changes"`
- Stopping early, or the developer is switching agents: `agentbrain handoff --reason "<why>"`

Never put secrets, tokens or credentials in AgentBrain fields.
<!-- agentbrain:end -->
