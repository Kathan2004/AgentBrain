<!-- agentbrain:start -->
## AgentBrain: task continuity across coding agents

This project uses AgentBrain to move tasks between AI coding agents. Another agent
may have worked on the current task before you, and another may continue after you.

**When the developer asks you to work on, continue or resume the current task:**
run this first and treat its output as your brief:

    agentbrain resume --agent copilot

It shows the objective, completed and remaining work, decisions, known failures,
the Git state and the next action. Continue from there; do not ask the developer
to re-explain. If there is no active task and the developer gave you a new one, run
`agentbrain task create "<objective>"` first.

**While working**, after each meaningful step (you may be cut off without warning):

    agentbrain task update --done "<finished step>" --todo "<new step>" --decision "<decision and why>" --failure "<what failed>" --next "<next action>"

- `--done <n>` marks remaining item n (as numbered in the brief) complete; `--fixed <n>` clears known failure n once it is fixed.
- Objective complete and verified: `agentbrain task update --status review --next "Review the changes"`
- Stopping early, or the developer is switching agents: `agentbrain handoff --reason "<why>"`

Never put secrets, tokens or credentials in AgentBrain fields.
<!-- agentbrain:end -->
