import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeRules } from "../src/core/rules.js";

describe("writeRules", () => {
  it("creates all targets and preserves existing content on re-run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-rules-"));
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# House rules\n\nUse tabs.\n");

    const first = writeRules(dir, "agentbrain");
    expect(first.map((r) => r.file)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      ".cursor/rules/agentbrain.mdc",
      ".github/copilot-instructions.md",
    ]);
    expect(first.find((r) => r.file === "CLAUDE.md")!.action).toBe("appended");

    const cursor = fs.readFileSync(path.join(dir, ".cursor/rules/agentbrain.mdc"), "utf8");
    expect(cursor).toMatch(/^---\ndescription: .*\nalwaysApply: true\n---/);
    expect(cursor).toContain("agentbrain resume --agent cursor");
    expect(fs.readFileSync(path.join(dir, ".github/copilot-instructions.md"), "utf8")).toContain(
      "agentbrain resume --agent copilot",
    );

    writeRules(dir, "agentbrain");
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude.startsWith("# House rules\n\nUse tabs.\n")).toBe(true);
    expect(claude.match(/agentbrain:start/g)).toHaveLength(1);
  });

  it("can target a subset and rejects unknown ids", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-rules-"));
    expect(writeRules(dir, "agentbrain", ["cursor"]).map((r) => r.file)).toEqual([".cursor/rules/agentbrain.mdc"]);
    expect(() => writeRules(dir, "agentbrain", ["vim"])).toThrow("Unknown rules target");
  });
});
