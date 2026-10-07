import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ab, activeTask, tempRepo } from "./helpers.js";

describe("task export", () => {
  it("exports the brief and timeline, and writes it with --out", () => {
    const repo = tempRepo("agentbrain-export-");
    ab(repo, ["init"]);
    ab(repo, ["task", "create", "Implement OAuth login"]);
    const taskId = activeTask(repo).id as string;
    ab(repo, [
      "task", "update", "--agent", "claude-code", "--session", "a1",
      "--done", "Implement OAuth login",
      "--decision", "Store tokens in httpOnly cookies",
      "--next", "Review the callback",
    ]);
    ab(repo, ["handoff", "--reason", "usage limit reached"]);

    const exported = ab(repo, ["export", taskId]).stdout;
    expect(exported).toContain("Implement OAuth login");
    expect(exported).toContain("Store tokens in httpOnly cookies");
    expect(exported).toContain("## History");
    expect(exported).toContain("claude-code");
    expect(exported).toContain("handoff");
    expect(exported).toContain("usage limit reached");
    expect(exported).toContain("## Instructions for the next agent");
    expect(exported).toContain("completed steps, decisions, failures, and the next action");

    const outputFile = path.join(repo, "task-export.md");
    const result = ab(repo, ["export", taskId, "--out", outputFile]);
    expect(result.stdout).toContain(outputFile);
    expect(fs.readFileSync(outputFile, "utf8")).toBe(exported);
  });
});