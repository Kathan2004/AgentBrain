import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readActivity } from "../src/core/activity.js";
import { createTask, updateTask } from "../src/core/actions.js";
import { describeTool, handleClaudeHook, installClaudeHooks, uninstallClaudeHooks } from "../src/core/claudehooks.js";
import {
  awaitingVote,
  faultTolerance,
  readReputation,
  reviewSummary,
  reviewTask,
  setChecks,
  setCouncil,
  setLead,
} from "../src/core/review.js";
import { getTask, initStore } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { tempRepo } from "./helpers.js";

const worker = (id: string) => ({ id, sessionId: `${id}-1` });

function setup(objective = "Add a greeting") {
  const repo = tempRepo("agentbrain-council-");
  initStore(repo);
  const task = addWorktree(repo, createTask(repo, objective).id);
  return { repo, task, wt: task.worktree!.path };
}

function commitIn(dir: string, file: string, content: string) {
  fs.writeFileSync(path.join(dir, file), content);
  execFileSync("git", ["add", file], { cwd: dir });
  execFileSync("git", ["commit", "-qm", `add ${file}`], { cwd: dir });
}

describe("lead agent", () => {
  it("holds a worker's finished task for the lead, who approves and merges it", () => {
    const { repo, task, wt } = setup();
    setLead(repo, "claude");
    commitIn(wt, "greet.ts", "export const hi = 1;\n");
    const after = updateTask(repo, task.id, { status: "done", done: ["1"], agent: worker("codex") });
    expect(after.status).toBe("review");
    expect(after.review?.worker).toBe("codex");
    expect(awaitingVote(repo, "claude-code").map((t) => t.id)).toEqual([task.id]);

    const result = reviewTask(repo, task.id, { verdict: "approved", reviewer: "claude-code" });
    expect(result.outcome).toBe("approved");
    expect(result.merged).toBe(1);
    expect(getTask(repo, task.id).status).toBe("done");
    expect(fs.existsSync(path.join(repo, "greet.ts"))).toBe(true);
  });

  it("lets the lead finish its own work, and sends changes back with notes as remaining items", () => {
    const { repo, task, wt } = setup();
    setLead(repo, "claude-code");
    commitIn(wt, "greet.ts", "x\n");
    expect(updateTask(repo, task.id, { status: "review", agent: worker("vscode") }).status).toBe("review");
    const result = reviewTask(repo, task.id, { verdict: "changes", reviewer: "claude-code", notes: "- add a test\n- handle empty names" });
    expect(result.outcome).toBe("changes");
    const back = getTask(repo, task.id);
    expect(back.status).toBe("handoff");
    expect(back.remaining).toEqual(expect.arrayContaining([task.objective, "add a test", "handle empty names"]));
    expect(back.reviews?.at(-1)).toMatchObject({ verdict: "changes", worker: "vscode" });

    const own = createTask(repo, "Lead's own task");
    expect(updateTask(repo, own.id, { status: "done", agent: worker("claude-code") }).status).toBe("done");
  });
});

describe("review council", () => {
  it("tolerates corrupted members: n members survive floor(n/3) at a two-thirds quorum", () => {
    expect(faultTolerance(3, 2 / 3)).toBe(1);
    expect(faultTolerance(4, 2 / 3)).toBe(1);
    expect(faultTolerance(7, 2 / 3)).toBe(2);
    expect(faultTolerance(2, 2 / 3)).toBe(0);
  });

  it("decides by quorum, so one corrupted reviewer cannot approve or block on its own", () => {
    const { repo, task, wt } = setup();
    setCouncil(repo, ["claude", "codex", "gemini", "cursor"]);
    commitIn(wt, "greet.ts", "export const hi = 1;\n");
    updateTask(repo, task.id, { status: "done", agent: worker("vscode") });

    // A compromised reviewer approves broken work: not enough on its own.
    let result = reviewTask(repo, task.id, { verdict: "approved", reviewer: "cursor" });
    expect(result.outcome).toBeUndefined();
    result = reviewTask(repo, task.id, { verdict: "changes", reviewer: "claude-code", notes: "greet.ts exports a number, not a function" });
    expect(result.outcome).toBeUndefined();
    result = reviewTask(repo, task.id, { verdict: "changes", reviewer: "codex", notes: "should export a function" });
    expect(result.outcome).toBe("changes");

    const decided = getTask(repo, task.id).reviews!.at(-1)!;
    expect(decided.reviewer).toBe("consensus");
    expect(decided.flags).toEqual(expect.arrayContaining([expect.objectContaining({ agent: "cursor", kind: "dissent" })]));
    const rep = readReputation(repo);
    expect(rep.cursor.score).toBeLessThan(1);
    expect(rep["claude-code"].score).toBeGreaterThan(1);
  });

  it("seals votes until the viewer has voted, and never lets a worker review itself", () => {
    const { repo, task, wt } = setup();
    setCouncil(repo, ["claude-code", "codex", "gemini", "cursor"]);
    commitIn(wt, "greet.ts", "x\n");
    updateTask(repo, task.id, { status: "done", agent: worker("codex") });
    expect(() => reviewTask(repo, task.id, { verdict: "approved", reviewer: "codex" })).toThrow(/own work/);
    reviewTask(repo, task.id, { verdict: "changes", reviewer: "gemini", notes: "rename it" });
    const sealed = reviewSummary(repo, getTask(repo, task.id), "claude-code");
    expect(sealed).toMatch(/sealed until you vote/);
    expect(sealed).not.toMatch(/rename it/);
    expect(reviewSummary(repo, getTask(repo, task.id), "gemini")).toMatch(/rename it/);
  });

  it("runs checks itself, blocks approval when they fail, and flags false claims and hallucinated files", () => {
    const { repo, task, wt } = setup();
    setCouncil(repo, ["claude-code", "gemini", "cursor"]);
    setChecks(repo, ["node -e \"process.exit(1)\""]);
    commitIn(wt, "greet.ts", "x\n");
    updateTask(repo, task.id, {
      status: "done",
      done: ["Added src/ghost.ts and all tests pass"],
      agent: worker("codex"),
    });
    const review = getTask(repo, task.id).review!;
    expect(review.checks?.[0].ok).toBe(false);
    const kinds = review.flags!.map((f) => f.kind);
    expect(kinds).toContain("false-claim");
    expect(kinds).toContain("hallucination");
    expect(readReputation(repo).codex.flagged).toBe(2);

    // Even unanimous approval cannot pass failing checks.
    reviewTask(repo, task.id, { verdict: "approved", reviewer: "claude-code" });
    reviewTask(repo, task.id, { verdict: "approved", reviewer: "gemini" });
    const last = reviewTask(repo, task.id, { verdict: "approved", reviewer: "cursor" });
    expect(last.tally?.blocked).toMatch(/checks failed/);
    expect(getTask(repo, task.id).status).not.toBe("done");
  });

  it("flags work that claims to be finished but changed nothing, and reviewers citing files that don't exist", () => {
    const { repo, task } = setup();
    setCouncil(repo, ["claude-code", "gemini", "cursor"]);
    updateTask(repo, task.id, { status: "done", agent: worker("codex") });
    expect(getTask(repo, task.id).review!.flags!.map((f) => f.kind)).toContain("no-change");
    reviewTask(repo, task.id, { verdict: "approved", reviewer: "cursor", notes: "Looks good, src/imaginary.ts is clean" });
    expect(getTask(repo, task.id).review!.flags).toEqual(expect.arrayContaining([expect.objectContaining({ agent: "cursor", kind: "hallucination" })]));
  });

  it("lets the developer override the council", () => {
    const { repo, task, wt } = setup();
    setCouncil(repo, ["claude-code", "gemini", "cursor"]);
    commitIn(wt, "greet.ts", "x\n");
    updateTask(repo, task.id, { status: "done", agent: worker("codex") });
    const result = reviewTask(repo, task.id, { verdict: "approved", reviewer: "developer" });
    expect(result.outcome).toBe("approved");
    expect(getTask(repo, task.id).reviews!.at(-1)!.reviewer).toBe("developer (override)");
  });
});

describe("Claude Code hooks", () => {
  it("installs into settings.local.json without touching other hooks, and uninstalls cleanly", () => {
    const repo = tempRepo("agentbrain-hooks-");
    fs.mkdirSync(path.join(repo, ".claude"));
    const own = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, model: "opus" };
    fs.writeFileSync(path.join(repo, ".claude/settings.local.json"), JSON.stringify(own));
    expect(installClaudeHooks(repo).action).toBe("updated");
    expect(installClaudeHooks(repo).action).toBe("unchanged");
    const settings = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.local.json"), "utf8"));
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0].matcher).toBe("*");
    expect(uninstallClaudeHooks(repo)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.local.json"), "utf8"))).toEqual(own);
  });

  it("streams prompts, edits and commands into the activity feed and tracks the session", () => {
    const { repo, task } = setup();
    const base = { session_id: "abc", cwd: repo };
    handleClaudeHook({ ...base, hook_event_name: "SessionStart", source: "startup" });
    handleClaudeHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the login bug" });
    handleClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path.join(repo, "src/login.ts") } });
    handleClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests" } });
    handleClaudeHook({ ...base, hook_event_name: "PostToolUse", tool_name: "mcp__agentbrain__agentbrain_update", tool_input: {} });
    const feed = readActivity(repo).filter((e) => e.agent === "claude-code");
    expect(feed.map((e) => e.kind)).toEqual(["session", "prompt", "edit", "command"]);
    expect(feed[2]).toMatchObject({ text: "Edited src/login.ts", files: ["src/login.ts"], task: task.id });
    const session = JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain/agents/claude-code/sessions/abc.json"), "utf8"));
    expect(session).toMatchObject({ activity: "working", lastAction: "$ npm test  (Run tests)" });
    handleClaudeHook({ ...base, hook_event_name: "Stop" });
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".agentbrain/agents/claude-code/sessions/abc.json"), "utf8")).activity).toBe("idle");
  });

  it("asks Claude to review waiting results once before it goes idle, when it is a reviewer", () => {
    const { repo, task, wt } = setup();
    setLead(repo, "claude-code");
    commitIn(wt, "greet.ts", "x\n");
    updateTask(repo, task.id, { status: "done", agent: worker("codex") });
    const stop = { session_id: "s1", cwd: repo, hook_event_name: "Stop" };
    const first = JSON.parse(handleClaudeHook(stop));
    expect(first.decision).toBe("block");
    expect(first.reason).toContain(task.id);
    expect(handleClaudeHook(stop)).toBe("");
    expect(handleClaudeHook({ ...stop, session_id: "s2", stop_hook_active: true })).toBe("");
  });

  it("describes tools briefly and skips AgentBrain's own", () => {
    expect(describeTool("Write", { file_path: "/r/a.md" }, "/r")).toMatchObject({ kind: "edit", text: "Wrote a.md" });
    expect(describeTool("mcp__agentbrain__agentbrain_brief", {})).toBeNull();
    expect(describeTool("mcp__github__create_issue", {})?.text).toBe("github: create_issue");
  });
});

describe("approving while someone else works in the main checkout", () => {
  it("merges when the main checkout's uncommitted changes are in other files, and names the files when they overlap", () => {
    const { repo, task, wt } = setup();
    setLead(repo, "claude-code");
    commitIn(wt, "greet.ts", "x\n");
    updateTask(repo, task.id, { status: "done", agent: worker("vscode") });
    // The developer (or another agent) is editing README.md in the main checkout.
    fs.writeFileSync(path.join(repo, "README.md"), "work in progress\n");
    const result = reviewTask(repo, task.id, { verdict: "approved", reviewer: "claude-code" });
    expect(result.outcome).toBe("approved");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("work in progress\n");

    const second = setup();
    setLead(second.repo, "claude-code");
    commitIn(second.wt, "README.md", "from the task\n");
    updateTask(second.repo, second.task.id, { status: "done", agent: worker("vscode") });
    fs.writeFileSync(path.join(second.repo, "README.md"), "local edit\n");
    expect(() => reviewTask(second.repo, second.task.id, { verdict: "approved", reviewer: "claude-code" })).toThrow(/README\.md has uncommitted changes/);
  });
});
