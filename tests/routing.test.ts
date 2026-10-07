import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routeTask } from "../src/core/routing.js";
import { ab, readJson, stubAgent, tempRepo } from "./helpers.js";

function setup() {
  const repo = tempRepo("agentbrain-route-");
  const bin = path.join(repo, "..", path.basename(repo) + "-bin");
  stubAgent(bin, "claude", "exit 0");
  stubAgent(bin, "gemini", "exit 0");
  const original = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${original}`;
  ab(repo, ["init"]);
  ab(repo, ["task", "create", "Build login"]);
  const taskId = readJson(path.join(repo, ".agentbrain/project.json")).activeTaskId as string;
  const restore = () => (process.env.PATH = original);
  return { repo, taskId, restore };
}

const byId = (list: ReturnType<typeof routeTask>, id: string, mode = "terminal") =>
  list.find((c) => c.id === id && c.mode === mode)!;

describe("agent routing", () => {
  it("steers away from an agent that just hit its usage limit", () => {
    const { repo, taskId, restore } = setup();
    try {
      ab(repo, ["task", "update", "--agent", "claude-code", "--session", "c1", "--next", "x"]);
      ab(repo, ["handoff", "--reason", "Claude usage limit reached"]);
      const ranked = routeTask(repo, taskId);
      const claude = byId(ranked, "claude-code");
      expect(claude.score).toBeLessThan(-50);
      expect(claude.reasons.join(" ")).toMatch(/hit a usage limit \d+ min ago/);
      expect(ranked[0].id).not.toBe("claude-code");
      // Hours later the limit has likely reset.
      const later = routeTask(repo, taskId, new Date(Date.now() + 6 * 3_600_000));
      expect(byId(later, "claude-code").score).toBeGreaterThan(-50);
    } finally {
      restore();
    }
  });

  it("learns from the project's history: finished tasks up, takeovers down", () => {
    const { repo, taskId, restore } = setup();
    try {
      // gemini finishes one task...
      ab(repo, ["task", "update", "--agent", "gemini", "--session", "g1", "--status", "review"]);
      // ...claude-code starts another and gets taken over mid-task by gemini.
      ab(repo, ["task", "create", "Build logout"]);
      ab(repo, ["task", "update", "--agent", "claude-code", "--session", "c1", "--next", "x"]);
      ab(repo, ["task", "update", "--agent", "gemini", "--session", "g2", "--next", "y"]);
      const ranked = routeTask(repo, taskId);
      expect(byId(ranked, "gemini").reasons).toContain("took 1 task(s) to review/done in this project");
      expect(byId(ranked, "claude-code").reasons).toContain("was taken over mid-task 1 time(s)");
      expect(byId(ranked, "gemini").score).toBeGreaterThan(byId(ranked, "claude-code").score);
    } finally {
      restore();
    }
  });

  it("honours prefer/avoid in project.json and ranks installed agents first", () => {
    const { repo, taskId, restore } = setup();
    try {
      const file = path.join(repo, ".agentbrain/project.json");
      fs.writeFileSync(file, JSON.stringify({ ...readJson(file), agents: { prefer: ["gemini"], avoid: ["claude-code"] } }));
      const ranked = routeTask(repo, taskId);
      expect(ranked[0]).toMatchObject({ id: "gemini", mode: "terminal" });
      expect(byId(ranked, "claude-code").score).toBeLessThan(-500);
      const firstMissing = ranked.findIndex((c) => !c.available);
      expect(ranked.slice(firstMissing).every((c) => !c.available)).toBe(true);
    } finally {
      restore();
    }
  });

  it("prints suggestions with launch commands", () => {
    const { repo, restore } = setup();
    try {
      const out = ab(repo, ["route"]).stdout;
      expect(out).toContain("Who should take task-");
      expect(out).toMatch(/\$ agentbrain run \S+ task-\d+/);
    } finally {
      restore();
    }
  });
});
