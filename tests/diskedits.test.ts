import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readActivity, recordActivity } from "../src/core/activity.js";
import { diskEditRecorder, editTarget, likelyEditor } from "../src/core/diskedits.js";
import { setLead } from "../src/core/review.js";
import { initStore } from "../src/core/store.js";
import { tempRepo } from "./helpers.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("edits nobody reported", () => {
  it("knows project source from AgentBrain's own files and build output", () => {
    const r = "/p";
    expect(editTarget(r, "/p/src/a.ts")).toEqual({ rel: "src/a.ts" });
    expect(editTarget(r, "/p/.agentbrain/worktrees/task-1/src/ui/tui.ts")).toEqual({ rel: "src/ui/tui.ts", task: "task-1" });
    expect(editTarget(r, "/p/.agentbrain/tasks/task-1/task.json")).toBeNull();
    expect(editTarget(r, "/p/dist/cli/main.js")).toBeNull();
    expect(editTarget(r, "/p/node_modules/x/index.js")).toBeNull();
    expect(editTarget(r, "/p/.git/HEAD")).toBeNull();
  });

  it("credits an unhooked lead, records an unreported edit once, and skips one an agent reported", async () => {
    const r = tempRepo("agentbrain-disk-");
    initStore(r);
    setLead(r, "cursor");
    expect(likelyEditor(r)).toBe("cursor");
    const rec = diskEditRecorder(r, 50);
    fs.writeFileSync(path.join(r, "a.ts"), "x\n");
    rec.changed(path.join(r, "a.ts"));
    rec.changed(path.join(r, "a.ts"));
    // Reported by a hooked agent: not recorded again.
    recordActivity(r, { agent: "claude-code", kind: "edit", text: "Edited b.ts", files: ["b.ts"] });
    rec.changed(path.join(r, "b.ts"));
    await wait(150);
    rec.stop();
    const edits = readActivity(r).filter((e) => e.kind === "edit" && /seen on disk/.test(e.text));
    expect(edits.map((e) => [e.agent, e.files?.[0]])).toEqual([["cursor", "a.ts"]]);
  });
});
