import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../src/core/activity.js";
import { commandName, renderRoom, stepperLine, storyLines, taskPageLines, taskStage, type RoomModel } from "../src/ui/console.js";

const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const at = "2026-10-12T10:00:00.000Z";
const ev = (e: Partial<ActivityEvent>): ActivityEvent => ({ at, agent: "claude-code", kind: "thought", text: "", ...e }) as ActivityEvent;

describe("the terminal's activity transcript", () => {
  it("names what ran, not its arguments", () => {
    expect(commandName("$ npm test")).toBe("npm test");
    expect(commandName("cd repo && npx vitest run tests/a.ts")).toBe("npx vitest");
    expect(commandName("S=/tmp/x; grep -n foo src")).toBe("grep");
    expect(commandName("git status --short")).toBe("git status");
    expect(commandName("")).toBe("a command");
    expect(commandName("python3 - <<'EOF'\nprint('hi')\nEOF")).toBe("python3");
  });

  it("wraps what an agent said instead of cutting it, labels your prompts as yours, and folds the work under it", () => {
    const long = "I'll make the sidebar wider so long task titles fit, then check that the narrow layout still works at eighty columns.";
    const lines = plain(storyLines([
      ev({ kind: "prompt", text: "make the sidebar wider" }),
      ev({ kind: "thought", text: long }),
      ev({ kind: "command", text: "$ npm test" }),
      ev({ kind: "edit", text: "Edited src/ui/tui.ts", files: ["src/ui/tui.ts"] }),
    ], 50));
    expect(lines.some((l) => l.includes("You → Claude Code"))).toBe(true);
    const said = lines.filter((l) => /^ {2}\S/.test(l) && !l.includes("⎿")).join(" ");
    expect(said).toContain("eighty columns.");
    expect(lines.every((l) => !l.endsWith("…") || l.includes("⎿"))).toBe(true);
    expect(lines.find((l) => l.includes("⎿"))).toMatch(/Ran npm test · edited tui\.ts/);
  });
});

describe("the terminal's task page", () => {
  const task = {
    id: "task-1",
    objective: ["Make the console faster.", ...Array.from({ length: 19 }, (_, i) => `Detail line ${i + 1} of the brief.`)].join("\n"),
    status: "review",
    request: "the tui feels slow, fix it",
    completed: ["Cache what the views show"],
    remaining: [],
    decisions: [],
    failures: [],
    files: ["src/ui/console.ts"],
  };

  it("folds a long brief to a few lines until you ask for all of it", () => {
    const short = plain(taskPageLines(task, [], 80));
    expect(short[0]).toContain("Make the console faster.");
    expect(short.some((l) => l.includes("b shows the whole brief"))).toBe(true);
    expect(short.filter((l) => l.includes("Detail line")).length).toBeLessThan(5);
    const full = plain(taskPageLines(task, [], 80, new Date(), { fullBrief: true }));
    expect(full.filter((l) => l.includes("Detail line")).length).toBe(19);
  });

  it("shows your own words, what's done and the files", () => {
    const lines = plain(taskPageLines(task, [], 80));
    const asked = lines.findIndex((l) => /^ You asked ─+$/.test(l));
    expect(lines[asked + 1]).toContain("the tui feels slow, fix it");
    expect(lines.some((l) => l.includes("✓ Cache what the views show"))).toBe(true);
    expect(lines.some((l) => l.includes("src/ui/console.ts"))).toBe(true);
  });

  it("shows where the task is, like the web's steps, and what review needs from you", () => {
    expect(taskStage({ status: "running" })).toBe(1);
    expect(taskStage({ status: "review", checksConfigured: true, checks: [] })).toBe(2);
    expect(taskStage({ status: "review", checksConfigured: true, checks: [{ command: "npm test", ok: true }] })).toBe(3);
    expect(plain([stepperLine({ status: "running" }, 80)])[0]).toMatch(/✓ Delegated ── ● Working ── ○ Checks ── ○ Review ── ○ Done/);
    expect(plain([stepperLine({ status: "review", checks: [{ command: "npm test", ok: false }] }, 80)])[0]).toContain("✗ Checks");
    expect(plain([stepperLine({ status: "done", reviewed: false }, 80)])[0]).toContain("– Review");
    const lines = plain(taskPageLines({
      ...task, nextAction: "Review the changes", finishedBy: "codex", checksConfigured: true,
      checks: [{ command: "npm test", ok: false }],
      flags: [{ kind: "false-claim", agent: "codex", text: "said tests pass" }],
    }, [], 80));
    expect(lines.some((l) => l.includes("▌ Next  Review the changes"))).toBe(true);
    expect(lines.some((l) => l.includes("Finished by Codex"))).toBe(true);
    expect(lines.some((l) => l.includes("✗ failed · npm test"))).toBe(true);
    expect(lines.some((l) => l.includes("⚠ False claim · Codex: said tests pass"))).toBe(true);
    expect(lines.some((l) => l.includes("/approve") && l.includes("/changes"))).toBe(true);
  });

  it("says an agent's repeated words once and folds the work after them together", () => {
    const lines = plain(storyLines([
      ev({ kind: "thought", text: "Checking the build." }),
      ev({ kind: "command", text: "$ npm run build" }),
      ev({ kind: "thought", text: "Checking the build." }),
      ev({ kind: "command", text: "$ npm test" }),
    ], 60));
    expect(lines.filter((l) => l.includes("Checking the build.")).length).toBe(1);
    expect(lines.find((l) => l.includes("⎿"))).toContain("Ran npm run, npm test");
  });

  it("frames the room: top bar, a divider that joins the rules, every line exactly the width", () => {
    const model: RoomModel = {
      project: "p", tasks: [{ id: "t1", objective: "Fix it", status: "review" }], team: [{ id: "codex", name: "Codex", up: true, lead: true }],
      agentsActive: 1, decides: "Lead: Codex", pane: "tasks", selectedId: "t1", body: ["hello"], buffer: "", cursor: 0,
      pills: { agent: "Auto", mode: "chat" }, hints: [["enter", "open"]], route: "next prompt → Codex",
    };
    const frame = renderRoom(model, 120, 30);
    const lines = plain(frame.lines);
    expect(frame.lines.every((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length === 120)).toBe(true);
    expect(lines[0]).toMatch(/^ ✻ AgentBrain {2}p .*● 1 to review/);
    expect(lines[1][frame.listWidth]).toBe("┬");
    expect(lines[frame.composeTop][frame.listWidth]).toBe("┴");
    expect(lines[frame.composeTop + 3]).toMatch(/^ enter open .*next prompt → Codex$/);
    expect(lines.some((l) => /NEEDS YOU +1/.test(l))).toBe(true);
  });

  it("reports where the view is scrolled, so keys and the wheel can move it", () => {
    const model: RoomModel = {
      project: "p", tasks: [], team: [], agentsActive: 0, decides: "You decide", pane: "activity",
      body: Array.from({ length: 100 }, (_, i) => `line ${i}`), buffer: "", cursor: 0, pills: { agent: "Auto", mode: "chat" },
    };
    const bottom = renderRoom(model, 100, 30);
    expect(bottom.top).toBe(bottom.maxTop);
    const up = renderRoom({ ...model, scroll: bottom.top - 10 }, 100, 30);
    expect(up.top).toBe(bottom.top - 10);
    expect(plain(up.lines).some((l) => /↓ \d+ more lines/.test(l))).toBe(true);
  });
});
