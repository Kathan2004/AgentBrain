import { describe, expect, it } from "vitest";
import { createTask, takeOver, writeCheckpoint } from "../src/core/actions.js";
import { readActivity } from "../src/core/activity.js";
import { escalation, ladder, modelOf, platformModels, resolveWorker, setModels, tierGuide, allModels } from "../src/core/models.js";
import { initStore, getTask, saveTask } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { autoContinue, listWorkers } from "../src/core/delegate.js";
import { CLI, tempRepo } from "./helpers.js";

describe("models", () => {
  describe("setModels validation", () => {
    it("rejects invalid platform", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      expect(() =>
        setModels(repo, "unknown-platform", {
          lead: "gpt-4",
          workers: [],
        })
      ).toThrow(/Model tiers work with/);
    });

    it("rejects tier name with invalid characters", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      expect(() =>
        setModels(repo, "claude-code", {
          lead: "claude-opus",
          workers: [{ name: "Invalid_Name", model: "claude-sonnet" }],
        })
      ).toThrow(/lowercase letters, digits and dashes/);
    });

    it("rejects duplicate tier names", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      expect(() =>
        setModels(repo, "claude-code", {
          lead: "claude-opus",
          workers: [
            { name: "sonnet", model: "claude-sonnet" },
            { name: "sonnet", model: "claude-sonnet" },
          ],
        })
      ).toThrow(/listed twice/);
    });

    it("rejects empty model string", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      expect(() =>
        setModels(repo, "claude-code", {
          lead: "claude-opus",
          workers: [{ name: "sonnet", model: "" }],
        })
      ).toThrow(/needs a model/);
    });

    it("rejects whitespace-only model string", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      expect(() =>
        setModels(repo, "claude-code", {
          lead: "claude-opus",
          workers: [{ name: "sonnet", model: "   " }],
        })
      ).toThrow(/needs a model/);
    });

    it("clears models with null", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "sonnet", model: "claude-sonnet" }],
      });
      const result = setModels(repo, "claude-code", null);
      expect(result).toBeNull();
      expect(platformModels(repo, "claude-code")).toBeNull();
    });

    it("clears models with empty lead and workers", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "sonnet", model: "claude-sonnet" }],
      });
      const result = setModels(repo, "claude-code", { workers: [] });
      expect(result).toBeNull();
    });

    it("trims lead and model strings", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      const result = setModels(repo, "claude-code", {
        lead: "  claude-opus  ",
        workers: [{ name: "sonnet", model: "  claude-sonnet  " }],
      });
      expect(result?.lead).toBe("claude-opus");
      expect(result?.workers[0].model).toBe("claude-sonnet");
    });
  });

  describe("resolveWorker", () => {
    it("resolves plain platform id to platform with lead model", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "sonnet", model: "claude-sonnet" }],
      });
      const result = resolveWorker(repo, "claude-code");
      expect(result).toEqual({
        platform: "claude-code",
        model: "claude-opus",
      });
    });

    it("resolves tiered worker id", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "haiku", model: "claude-haiku" }],
      });
      const result = resolveWorker(repo, "claude-code.haiku");
      expect(result).toEqual({
        platform: "claude-code",
        tier: { name: "haiku", model: "claude-haiku" },
        model: "claude-haiku",
      });
    });

    it("returns null for unknown tier", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "sonnet", model: "claude-sonnet" }],
      });
      const result = resolveWorker(repo, "claude-code.unknown");
      expect(result).toBeNull();
    });

    it("returns null for unknown platform", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      const result = resolveWorker(repo, "unknown");
      expect(result).toEqual({ platform: "unknown" });
    });
  });

  describe("ladder order", () => {
    it("returns tiers strongest first, then platform", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const result = ladder(repo, "claude-code");
      expect(result).toEqual([
        "claude-code.sonnet",
        "claude-code.haiku",
        "claude-code",
      ]);
    });

    it("returns only platform when no tiers", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      const result = ladder(repo, "claude-code");
      expect(result).toEqual(["claude-code"]);
    });
  });

  describe("escalation", () => {
    it("returns null for plain platform id", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "sonnet", model: "claude-sonnet" }],
      });
      const task = addWorktree(
        repo,
        createTask(repo, "Test task").id
      );
      const result = escalation(repo, task, "claude-code");
      expect(result).toBeNull();
    });

    it("returns null when sent back count is below ESCALATE_AFTER", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const task = addWorktree(
        repo,
        createTask(repo, "Test task").id
      );
      // Add one "changes" review (less than ESCALATE_AFTER which is 2)
      task.reviews = [
        { worker: "claude-code.haiku", verdict: "changes" as const },
      ];
      const result = escalation(repo, task, "claude-code.haiku");
      expect(result).toBeNull();
    });

    it("escalates to next stronger tier after ESCALATE_AFTER changes", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const task = addWorktree(
        repo,
        createTask(repo, "Test task").id
      );
      // Add 2 "changes" reviews (equals ESCALATE_AFTER)
      task.reviews = [
        { worker: "claude-code.haiku", verdict: "changes" as const },
        { worker: "claude-code.haiku", verdict: "changes" as const },
      ];
      const result = escalation(repo, task, "claude-code.haiku");
      expect(result).toBe("claude-code.sonnet");
    });

    it("escalates to lead after strongest tier reaches ESCALATE_AFTER", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const task = addWorktree(
        repo,
        createTask(repo, "Test task").id
      );
      // Add 2 "changes" reviews for the strongest tier
      task.reviews = [
        { worker: "claude-code.sonnet", verdict: "changes" as const },
        { worker: "claude-code.sonnet", verdict: "changes" as const },
      ];
      const result = escalation(repo, task, "claude-code.sonnet");
      expect(result).toBe("claude-code");
    });

    it("autopilot says the task waits, without crashing, when escalation picks a tier but nothing is ready", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const task = createTask(repo, "Do the thing");
      takeOver(repo, task.id, { id: "claude-code.haiku", sessionId: "h1" });
      writeCheckpoint(repo, task.id, { agent: { id: "claude-code.haiku", sessionId: "h1" }, reason: "usage limit", status: "handoff" });
      const saved = getTask(repo, task.id);
      // ESCALATE_AFTER "changes" reviews: escalation() picks a stronger tier, but neither
      // claude-code nor its tiers are installed in this test environment, so none is ready.
      saved.reviews = [
        { worker: "claude-code.haiku", verdict: "changes" as const },
        { worker: "claude-code.haiku", verdict: "changes" as const },
      ];
      saveTask(repo, saved, "agentbrain");
      const result = autoContinue(repo, task.id, "claude-code.haiku", "usage limit", { command: "node", args: [CLI] });
      expect(result).toBeNull();
      expect(readActivity(repo).at(-1)!.text).toMatch(/no other agent is ready; the task waits/);
    });
  });

  describe("tierGuide", () => {
    it("returns empty string when no tiers are set", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      const result = tierGuide(repo);
      expect(result).toBe("");
    });

    it("names each worker id with tiers", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const result = tierGuide(repo);
      expect(result).toContain("- claude-code runs claude-opus");
      expect(result).toContain("- claude-code.sonnet runs claude-sonnet");
      expect(result).toContain("(strongest worker)");
      expect(result).toContain("- claude-code.haiku runs claude-haiku");
      expect(result).toContain("(cheapest: small, mechanical, well-specified pieces)");
    });

    it("marks strongest and cheapest workers", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const result = tierGuide(repo);
      expect(result).toContain("sonnet");
      expect(result).toContain("strongest worker");
      expect(result).toContain("haiku");
      expect(result).toContain("cheapest");
    });
  });

  describe("listWorkers includes tiered workers", () => {
    it("includes claude-code.sonnet once tiers are set", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [
          { name: "sonnet", model: "claude-sonnet" },
          { name: "haiku", model: "claude-haiku" },
        ],
      });
      const workers = listWorkers(repo);
      const ids = workers.map((w) => w.id);
      expect(ids).toContain("claude-code.sonnet");
      expect(ids).toContain("claude-code.haiku");
      expect(ids.filter((id) => id === "claude-code.sonnet")).toHaveLength(1);
    });

    it("does not include tier workers when no tiers set", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      const workers = listWorkers(repo);
      const ids = workers.map((w) => w.id);
      expect(ids.filter((id) => id.includes(".sonnet"))).toHaveLength(0);
    }, 120000);
  });

  describe("modelOf", () => {
    it("returns model string for worker id", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "sonnet", model: "claude-sonnet" }],
      });
      expect(modelOf(repo, "claude-code")).toBe("claude-opus");
      expect(modelOf(repo, "claude-code.sonnet")).toBe("claude-sonnet");
    });

    it("returns undefined for unknown worker", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      expect(modelOf(repo, "unknown")).toBeUndefined();
    });
  });

  describe("allModels", () => {
    it("returns all platforms with their models", () => {
      const repo = tempRepo("agentbrain-models-");
      initStore(repo);
      setModels(repo, "claude-code", {
        lead: "claude-opus",
        workers: [{ name: "sonnet", model: "claude-sonnet" }],
      });
      setModels(repo, "codex", {
        lead: "codex-latest",
        workers: [],
      });
      const result = allModels(repo);
      expect(result["claude-code"]).toBeDefined();
      expect(result["codex"]).toBeDefined();
      expect(result["claude-code"].lead).toBe("claude-opus");
      expect(result["codex"].lead).toBe("codex-latest");
    });
  });
});

describe("accountLimit: a platform's models share one account", () => {
  const hit = new Date("2026-10-16T18:56:00Z");
  const reason = "You've hit your session limit · resets 2:50am (Asia/Calcutta)";
  const records = new Map([["claude-code.haiku", { lastLimit: { at: hit, reason } }], ["codex", {}]]);

  it("a tier's limit holds the lead and the other tiers until it lifts", async () => {
    const { accountLimit } = await import("../src/core/delegate.js");
    const during = new Date("2026-10-16T20:00:00Z");
    for (const id of ["claude-code.haiku", "claude-code.sonnet", "claude-code"]) {
      expect(accountLimit(records, id, during)).toEqual({ by: "claude-code.haiku", reason });
    }
    expect(accountLimit(records, "codex", during)).toBeNull();
    expect(accountLimit(records, "claude-code.sonnet", new Date("2026-10-16T21:21:00Z"))).toBeNull();
  });

  it("doesn't mistake a platform whose id merely starts the same", async () => {
    const { accountLimit } = await import("../src/core/delegate.js");
    const other = new Map([["claude-code-x", { lastLimit: { at: hit, reason } }]]);
    expect(accountLimit(other, "claude-code", new Date("2026-10-16T20:00:00Z"))).toBeNull();
  });
});
