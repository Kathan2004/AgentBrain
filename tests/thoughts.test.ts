import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { latestThought, thoughtFrom } from "../src/core/thoughts.js";
import { describeThought } from "../src/core/printrun.js";

describe("an agent's stated reasons", () => {
  it("take the narration of a message, tidied, and skip tool-only messages", () => {
    expect(thoughtFrom([{ type: "text", text: "I'll make **closeTask** remove the worktree,\n since `doctor` reports nine." }]))
      .toBe("I'll make closeTask remove the worktree, since doctor reports nine.");
    expect(thoughtFrom([{ type: "tool_use", name: "Edit", input: {} }])).toBeNull();
    expect(thoughtFrom([{ type: "text", text: "ok" }])).toBeNull();
    expect(thoughtFrom([{ type: "thinking", thinking: "The flake comes from timestamps in the same millisecond." }])).toMatch(/same millisecond/);
    // A long thought is cut on a sentence boundary and marked, never left mid-word.
    const long = thoughtFrom([{ type: "text", text: "I'll rename the field. ".repeat(40) }])!;
    expect(long.length).toBeLessThanOrEqual(340);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/\bren…$/);
  });

  it("strips a thinking model's rambling lead-in and keeps the point", () => {
    expect(thoughtFrom([{ type: "text", text: "Okay, let me try to figure out how to approach this. I'll approve the result because the checks pass." }]))
      .toBe("I'll approve the result because the checks pass.");
    expect(thoughtFrom([{ type: "text", text: "Hmm, so let me think. First, I need to check the signature." }]))
      .toMatch(/check the signature/);
    // Filler with nothing after it is kept rather than emptied out.
    expect(thoughtFrom([{ type: "text", text: "Let me think about this carefully now." }])).toMatch(/\w/);
  });

  it("read the latest one from a Claude Code transcript", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-thought-")), "t.jsonl");
    const line = (o: unknown) => JSON.stringify(o);
    fs.writeFileSync(file, [
      line({ type: "user", message: { content: "fix the bug" } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "First I'll read the failing test to see what it expects." }] } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }),
      "",
    ].join("\n"));
    expect(latestThought(file)).toBe("First I'll read the failing test to see what it expects.");
    expect(latestThought(path.join(path.dirname(file), "missing.jsonl"))).toBeNull();
  });

  it("come from background runs' output too", () => {
    expect(describeThought("claude-code", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Now I'll run the whole suite to check nothing else broke." }] } })))
      .toMatch(/whole suite/);
    expect(describeThought("codex", JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "The status command reads activeTaskId without checking it." } })))
      .toMatch(/activeTaskId/);
    expect(describeThought("claude-code", "not json")).toBeNull();
  });
});
