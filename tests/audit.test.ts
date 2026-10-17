import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { auditFile, auditTrail, formatAudit } from "../src/core/audit.js";
import { setModels } from "../src/core/models.js";
import { reviewTask, setLead } from "../src/core/review.js";
import { getTask, initStore } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { tempRepo } from "./helpers.js";

const WORKER = "claude-code.haiku";
const FILE = "src/feature.ts";

/** A task worked by `WORKER`, approved by the lead, landed on main. */
function landedTask(options: { sendBack?: boolean } = {}) {
  const repo = tempRepo("agentbrain-audit-");
  initStore(repo);
  setModels(repo, "claude-code", { workers: [{ name: "haiku", model: "haiku" }] });
  setLead(repo, "claude-code");

  const task = addWorktree(repo, createTask(repo, "Add a feature flag").id);
  const wt = task.worktree!.path;
  fs.mkdirSync(path.dirname(path.join(wt, FILE)), { recursive: true });
  fs.writeFileSync(path.join(wt, FILE), "export const feature = true;\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "feature"], { cwd: wt });

  updateTask(repo, task.id, { status: "review", agent: { id: WORKER, sessionId: `${WORKER}-1` } });

  if (options.sendBack) {
    reviewTask(repo, task.id, { verdict: "changes", reviewer: "claude-code", notes: `${FILE}: add a test` });
    updateTask(repo, task.id, { status: "review", agent: { id: WORKER, sessionId: `${WORKER}-1` } });
  }

  reviewTask(repo, task.id, { verdict: "approved", reviewer: "claude-code" });
  expect(getTask(repo, task.id).status).toBe("done");
  return { repo, id: task.id };
}

describe("audit trail", () => {
  it("records who wrote a landed result, its model, and who approved it, plus any send-back", () => {
    const { repo, id } = landedTask({ sendBack: true });
    const entries = auditTrail(repo);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.task).toBe(id);
    expect(entry.worker).toBe(WORKER);
    expect(entry.model).toBe("haiku");
    expect(entry.files).toContain(FILE);
    expect(entry.commit).toBeTruthy();
    expect(entry.approval).toEqual({ how: "lead", by: ["claude-code"], at: expect.any(String) });
    expect(entry.sentBack).toHaveLength(1);
    expect(entry.sentBack[0]).toMatchObject({ by: "claude-code", notes: `${FILE}: add a test` });
  });

  it("the since filter keeps only entries at or after it", () => {
    const { repo, id } = landedTask();
    expect(auditTrail(repo, { since: "2999-01-01" })).toEqual([]);
    expect(auditTrail(repo, { since: "2000-01-01" }).map((e) => e.task)).toContain(id);
  });

  it("the file filter keeps only entries that touched it", () => {
    const { repo, id } = landedTask();
    expect(auditTrail(repo, { file: FILE }).map((e) => e.task)).toContain(id);
    expect(auditTrail(repo, { file: "src/other.ts" })).toEqual([]);
  });

  it("formatAudit mentions the worker, its model, and the approver", () => {
    const { repo } = landedTask();
    const text = formatAudit(auditTrail(repo));
    expect(text).toContain(WORKER);
    expect(text).toContain("haiku");
    expect(text).toContain("claude-code");
  });

  it("auditFile attributes the landed file's lines to the worker and its task", () => {
    const { repo, id } = landedTask();
    const ranges = auditFile(repo, FILE);
    expect(ranges.length).toBeGreaterThan(0);
    for (const r of ranges) {
      expect(r.by).toBe(WORKER);
      expect(r.model).toBe("haiku");
      expect(r.task).toBe(id);
    }
  });
});
