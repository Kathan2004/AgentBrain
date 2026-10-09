# AgentBrain control plane

AgentBrain is the orchestrator that sits beside whatever agent you are already
using. You keep working in your own terminal: Claude Code, Codex, Copilot,
Cursor, or a plain shell. You switch AgentBrain on, and from then on it sees
what every agent does, remembers it, and decides whose work counts.

```
 your terminal (e.g. claude)          the control room (browser, side by side)
┌──────────────────────────┐        ┌───────────────────────────────────────────┐
│ > ! agentbrain on        │        │ AgentBrain · repo   Lead: Claude Code ▾   │
│ ✓ connected 5 agents     │        ├──────────┬──────────────────┬─────────────┤
│ ✓ streaming Claude Code  │  ───►  │ Agents   │ Activity · Brain │ Review      │
│ ✓ control room: http://… │        │ ● claude │ 12:01 copilot    │ task-17     │
│                          │        │   working│  edit src/a.ts   │ by copilot  │
│ > fix the login bug      │        │ ● copilot│ 12:02 claude     │ [approve]   │
│ …                        │        │   idle   │  $ npm test      │ [changes]   │
└──────────────────────────┘        └──────────┴──────────────────┴─────────────┘
```

## 1. Switch on, from any terminal

`agentbrain on` is the only command you need. It is idempotent and safe to run
inside an agent (`! agentbrain on` in Claude Code). It:

1. initializes `.agentbrain/` if the repo has none;
2. connects every agent to the AgentBrain MCP server (live task state + tools);
3. installs activity hooks where an agent supports them (Claude Code today), so
   every prompt, edit and command streams into AgentBrain as it happens;
4. installs the commit hook;
5. starts the control room in the background (one per repo, reused) and prints
   its URL, opening it unless `--no-open`.

`agentbrain off` removes the activity hooks and stops the control room. Task
state, memory and MCP configs stay.

## 2. The control room

One page, live (server-sent events), local only (127.0.0.1, per-run token).

| Panel | Shows | Source |
|---|---|---|
| **Agents** | every agent session: working / idle / waiting / ended, its task, its last action; stop or message headless ones | session records, hooks, headless runs |
| **Activity** | the live feed of what agents are doing: prompts, edits, commands, commits, status changes, handoffs, reviews | `.agentbrain/activity.jsonl` |
| **Brain** | the memory as a graph: tasks, agents, decisions, failures, files, linked by who did what | tasks, checkpoints, activity |
| **Review** | finished work with checks, flags and the vote tally | tasks in `review` |
| **Decisions & handoffs** | the timeline of choices and changes of hands | tasks, activity |
| **Who decides** | each agent, a lead, or a council with quorum | `project.json` |

The same memory is written as an Obsidian vault in `.agentbrain/vault/`: one
note per task and per agent, linked with `[[wikilinks]]`, so Obsidian's graph
view shows the brain too.

## 3. Who decides: a lead or a council

Finished work only counts once someone you trust has checked it. You choose:

- **Each agent** (default): agents finish their own tasks.
- **Lead** (`agentbrain lead claude-code`): one agent reviews every other
  agent's work and finishes its own.
- **Council** (`agentbrain council claude-code codex gemini cursor`): every
  result, whoever made it, is voted on by the other members.

When a worker marks a task `done` or `review`, the task waits in `review`, and
AgentBrain verifies it before anyone votes:

1. **Checks it runs itself** (`agentbrain checks "npm test"`), in the task's
   folder, in the background. This is the proof of work: evidence no agent can
   fake. Failing checks block approval regardless of votes.
2. **Claim verification.** The worker's claims are compared with the evidence
   and contradictions are flagged: claims that checks pass when they failed,
   "done" with nothing changed, files mentioned that don't exist. A flagged
   worker loses reputation.

Then the reviewers vote (`agentbrain_review` over MCP, or `agentbrain review`):

- **Sealed votes**: a reviewer's packet hides other votes until it has voted,
  so one compromised reviewer can't anchor the rest.
- **Reputation as stake**: votes are weighted by track record (start 1.0,
  +0.1 for agreeing with the outcome, −0.2 for dissent, −0.3 per flag, kept
  between 0.2 and 3). Stored in `.agentbrain/reputation.json`.
- **Quorum**: approve when approving weight reaches the quorum (default 2/3);
  send back as soon as approval can no longer reach it. With equal weights the
  honest members alone reach the quorum and the corrupted ones alone can
  neither approve nor block, as long as at most ⌊n·(1 − q)⌋ are corrupted:
  3 or 4 members tolerate 1, 7 tolerate 2.
- **No self-review**: a worker never votes on its own result.
- **Reviewers can hallucinate too**: a review citing files that don't exist is
  flagged; votes against the final outcome are flagged as dissent.

Approval merges the task's branch (conflicts abort the merge and keep the task
in review) and marks it done. Changes turn the reviewers' notes into remaining
items and hand the task back. The developer's verdict always decides and is
recorded as an override.

In Claude Code a reviewer is nudged automatically: the stop hook hands it the
results waiting for its vote, once per result per session, and each prompt
carries a one-line reminder.

What this does not do: agents on the same underlying model can share a blind
spot, so a council is strongest with mixed vendors; and flags only catch claims
that can be checked mechanically.

## 4. What is recorded

Activity events are one JSON object per line in `.agentbrain/activity.jsonl`
(capped; older lines are dropped), redacted like all stored text:

```json
{"at":"2026-10-09T12:01:03Z","agent":"claude-code","session":"…","task":"task-17","kind":"edit","text":"Edit src/login.ts","files":["src/login.ts"]}
```

Kinds: `session`, `prompt`, `tool`, `edit`, `command`, `commit`, `status`,
`progress`, `decision`, `handoff`, `review`.

## 5. Build order

1. Activity log, Claude Code hooks, `agentbrain on` / `off`.
2. Lead agent, review council, checks and claim verification (core, MCP, CLI, Claude Code nudge).
3. Brain graph and the Obsidian vault.
4. The control room page.
