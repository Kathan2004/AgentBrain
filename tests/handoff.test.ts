import { describe, expect, it } from "vitest";
import { makeCheckpoint, renderHandoff } from "../src/core/handoff.js";

describe("handoff", () => {
  it("creates portable checkpoint state", () => {
    const task = {
      id: "task-1",
      objective: "Build login",
      status: "running" as const,
      completed: ["Created endpoint"],
      remaining: ["Add tests"],
      decisions: ["Use JWT"],
      failures: ["Expired token test fails"],
      nextAction: "Add tests",
    };

    const checkpoint = makeCheckpoint(task, {
      head: "abc123",
      branch: "main",
      dirty: true,
      changedFiles: ["src/auth.ts"],
    });

    expect(checkpoint.taskId).toBe("task-1");
    expect(checkpoint.progress.remaining).toContain("Add tests");
    expect(checkpoint.git.head).toBe("abc123");

    const handoff = renderHandoff(task, checkpoint);
    expect(handoff).toContain("Build login");
    expect(handoff).toContain("Add tests");
    expect(handoff).toContain("Use JWT");
  });

  it("keeps the brief short after a long history", () => {
    const completed = Array.from({ length: 20 }, (_, i) => `step ${i + 1}`);
    const task = {
      id: "task-2",
      objective: "Long task",
      status: "running" as const,
      completed,
      remaining: ["step 21"],
      decisions: [],
      failures: [],
    };
    const checkpoint = makeCheckpoint(task, { head: "abc", branch: "main", dirty: false, changedFiles: [] });
    const md = renderHandoff(task, checkpoint);
    expect(md).toContain("(8 earlier items in task.json)");
    expect(md).toContain("- step 20");
    expect(md).not.toContain("- step 1\n");
    expect(checkpoint.progress.completed).toHaveLength(20);
  });
});
