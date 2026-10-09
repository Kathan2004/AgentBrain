import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { delegate, rankWorkers } from "../src/core/delegate.js";
import { effectiveLimits, getLimits, limitReason, setLimits } from "../src/core/limits.js";
import { getProject, initStore, saveTask } from "../src/core/store.js";
import { ab, readJson, tempRepo } from "./helpers.js";

describe("agent limits", () => {
  it("merges defaults with per-agent overrides", () => {
    const repo = tempRepo("agentbrain-limits-");
    initStore(repo);
    setLimits(repo, "default", { maxParallel: 2, dailyTasks: 5 });
    setLimits(repo, "codex", { dailyTasks: 3 });
    expect(effectiveLimits(getProject(repo), "codex")).toEqual({ maxParallel: 2, dailyTasks: 3 });
  });

  it("marks a worker at maxParallel unavailable and refuses explicit delegation", () => {
    const repo = tempRepo("agentbrain-limits-");
    initStore(repo);
    setLimits(repo, "any", { maxParallel: 1 });
    const task = createTask(repo, "Busy");
    updateTask(repo, task.id, { status: "running", agent: { id: "any" } });
    const choice = rankWorkers(repo).find((item) => item.worker.id === "any")!;
    expect(choice.worker.available).toBe(false);
    expect(choice.worker.note).toBe("at its limit of 1 parallel tasks");
    expect(() => delegate(repo, { prompt: "@any do this" }, { command: "node", args: [] }))
      .toThrow("at its limit of 1 parallel tasks");
  });

  it("counts delegated tasks since local midnight", () => {
    const repo = tempRepo("agentbrain-limits-");
    initStore(repo);
    setLimits(repo, "codex", { dailyTasks: 2 });
    for (let index = 0; index < 2; index++) {
      const task = createTask(repo, `Delegated ${index}`);
      task.delegatedTo = { worker: "codex", at: new Date().toISOString() };
      saveTask(repo, task);
    }
    expect(limitReason(repo, "codex")).toBe("at its daily limit of 2 delegated tasks");
  });

  it("clears an agent entry", () => {
    const repo = tempRepo("agentbrain-limits-");
    initStore(repo);
    setLimits(repo, "gemini", { maxRunMinutes: 20 });
    expect(getLimits(repo).gemini.maxRunMinutes).toBe(20);
    setLimits(repo, "gemini", null);
    expect(getLimits(repo).gemini).toBeUndefined();
  });

  it("configures limits through the CLI", () => {
    const repo = tempRepo("agentbrain-limits-");
    ab(repo, ["init"]);
    const result = ab(repo, ["limits", "default", "--parallel", "2", "--daily", "5"]);
    expect(result.stdout).toContain("Updated limits for default");
    const shown = ab(repo, ["limits"]).stdout;
    expect(shown).toContain("default: parallel=2");
    expect(shown).toContain("daily=5");
    expect(readJson(path.join(repo, ".agentbrain/project.json")).limits.default).toEqual({ maxParallel: 2, dailyTasks: 5 });
  });
});
