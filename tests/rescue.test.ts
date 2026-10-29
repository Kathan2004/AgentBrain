import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordActivity } from "../src/core/activity.js";
import { createTask, takeOver, updateTask } from "../src/core/actions.js";
import { autoContinue } from "../src/core/delegate.js";
import { awaitingResume, rescueStalledChats, resumeSentBack, retryWaiting } from "../src/core/rescue.js";
import { CONFLICT_PREFIX, reviewTask, setLead } from "../src/core/review.js";
import { getTask, initStore, saveTask } from "../src/core/store.js";
import { stubAgent, tempRepo } from "./helpers.js";

// Which agents are installed differs per machine: record the hand-over instead of starting one.
vi.mock("../src/core/delegate.js", async (original) => ({
  ...(await original<typeof import("../src/core/delegate.js")>()),
  autoContinue: vi.fn(() => ({})),
}));

const self = { command: "true", args: [] as string[] };
beforeEach(() => vi.mocked(autoContinue).mockClear());

describe("chat autopilot", () => {
  it("hands on a chat agent's task after 20 minutes without any sign of life", () => {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    const task = createTask(repo, "Add a greeting");
    takeOver(repo, task.id, { id: "vscode", sessionId: "v1" });
    expect(rescueStalledChats(repo, self, new Date(Date.now() + 5 * 60_000))).toEqual([]);
    expect(getTask(repo, task.id).status).toBe("running");

    rescueStalledChats(repo, self, new Date(Date.now() + 25 * 60_000));
    expect(getTask(repo, task.id).status).toBe("handoff");
  });

  it("leaves a chat alone while it is still calling tools", () => {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    const task = createTask(repo, "Add a greeting");
    takeOver(repo, task.id, { id: "vscode", sessionId: "v1" });
    const later = new Date(Date.now() + 25 * 60_000);
    recordActivity(repo, { agent: "vscode", task: task.id, kind: "tool", text: "Read src/a.ts", at: new Date(later.getTime() - 60_000).toISOString() } as never);
    rescueStalledChats(repo, self, later);
    expect(getTask(repo, task.id).status).toBe("running");
  });
});

describe("sent-back autopilot", () => {
  function submitted() {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    setLead(repo, "codex");
    const task = createTask(repo, "Add a greeting");
    takeOver(repo, task.id, { id: "vscode", sessionId: "v1" });
    updateTask(repo, task.id, { status: "review", agent: { id: "vscode", sessionId: "v1" } });
    return { repo, id: task.id };
  }

  it("hands a task the review sent back to an agent once, preferring the one that did it", () => {
    const { repo, id } = submitted();
    reviewTask(repo, id, { verdict: "changes", reviewer: "codex", notes: "Add a test" });
    expect(getTask(repo, id).status).toBe("handoff");
    expect(getTask(repo, id).events?.at(-1)?.agent).toBe("codex");
    // `agentbrain wait` keeps waiting through this gap.
    expect(awaitingResume(repo, getTask(repo, id))).toBe(true);

    expect(resumeSentBack(repo, self)).toEqual([id]);
    expect(awaitingResume(repo, getTask(repo, id))).toBe(false);
    expect(autoContinue).toHaveBeenCalledWith(repo, id, "codex", "Add a test", self, { prefer: "vscode", sentBack: true });
    // Still handed off (nobody picked it up yet): not handed on again.
    expect(resumeSentBack(repo, self)).toEqual([]);
    expect(autoContinue).toHaveBeenCalledTimes(1);
  });

  it("hands on an approved result that conflicts with main", () => {
    const { repo, id } = submitted();
    const task = getTask(repo, id);
    task.status = "handoff";
    task.remaining = [`${CONFLICT_PREFIX} src/a.ts`, ...task.remaining];
    delete task.review;
    saveTask(repo, task, "agentbrain");

    expect(resumeSentBack(repo, self)).toEqual([id]);
    expect(autoContinue).toHaveBeenCalledWith(repo, id, "agentbrain", `${CONFLICT_PREFIX} src/a.ts`, self, { prefer: "vscode", sentBack: true });
    expect(resumeSentBack(repo, self)).toEqual([]);
  });

  it("leaves a task an agent handed off when it stopped to the existing autopilot", () => {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    setLead(repo, "codex");
    const task = createTask(repo, "Add a greeting");
    takeOver(repo, task.id, { id: "claude-code", sessionId: "c1" });
    updateTask(repo, task.id, { status: "handoff", agent: { id: "claude-code", sessionId: "c1" } });
    expect(getTask(repo, task.id).status).toBe("handoff");
    expect(resumeSentBack(repo, self)).toEqual([]);
    expect(autoContinue).not.toHaveBeenCalled();
  });
});

describe("retry waiting autopilot", () => {
  function waiting() {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    const task = createTask(repo, "Add a greeting");
    updateTask(repo, task.id, { status: "handoff", agent: { id: "claude-code", sessionId: "c1" } });
    recordActivity(repo, { agent: "agentbrain", task: task.id, kind: "handoff", text: "Autopilot: claude-code stopped (usage limit) and no agent is ready; the task waits" });
    // What autoContinue leaves on the task when it gives up.
    const t = getTask(repo, task.id);
    t.waitingSince = new Date().toISOString();
    saveTask(repo, t);
    return { repo, id: task.id };
  }

  it("still retries a task whose waiting line has scrolled out of a busy activity log", () => {
    const { repo, id } = waiting();
    for (let i = 0; i < 700; i++) recordActivity(repo, { agent: "claude-code", task: id, kind: "command", text: `$ ls ${i}` });
    withAgentOnPath(repo, () => {
      expect(retryWaiting(repo, self, new Date(Date.now() + 3 * 60_000))).toEqual([id]);
    });
  });

  it("leaves a handed-off task alone when autopilot never gave up on it", () => {
    const repo = tempRepo("agentbrain-rescue-");
    initStore(repo);
    const task = createTask(repo, "Add a greeting");
    updateTask(repo, task.id, { status: "handoff", agent: { id: "claude-code", sessionId: "c1" } });
    withAgentOnPath(repo, () => {
      expect(retryWaiting(repo, self, new Date(Date.now() + 3 * 60_000))).toEqual([]);
    });
  });

  // An available non-"pull" worker, without depending on what's signed in on the test machine.
  function withAgentOnPath<T>(repo: string, run: () => T): T {
    const bin = `${repo}-bin`;
    stubAgent(bin, "gemini", "exit 0");
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    try {
      return run();
    } finally {
      process.env.PATH = before;
    }
  }

  it("retries a waiting task once an agent is available", () => {
    const { repo, id } = waiting();
    withAgentOnPath(repo, () => {
      const later = new Date(Date.now() + 3 * 60_000);
      expect(retryWaiting(repo, self, later)).toEqual([id]);
      expect(autoContinue).toHaveBeenCalledWith(repo, id, "claude-code", "an agent is available again", self);
    });
  });

  it("does not retry twice within 5 minutes", () => {
    const { repo, id } = waiting();
    withAgentOnPath(repo, () => {
      const first = new Date(Date.now() + 3 * 60_000);
      expect(retryWaiting(repo, self, first)).toEqual([id]);
      expect(autoContinue).toHaveBeenCalledTimes(1);

      const soonAfter = new Date(first.getTime() + 2 * 60_000);
      expect(retryWaiting(repo, self, soonAfter)).toEqual([]);
      expect(autoContinue).toHaveBeenCalledTimes(1);
    });
  });
});
