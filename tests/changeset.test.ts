import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { readChangesets } from "../src/core/changeset.js";
import { fileHistory, formatHistory } from "../src/core/history.js";
import { computeTally, reviewTask, setLead } from "../src/core/review.js";
import { kindOf, setReviewRules } from "../src/core/reviewrules.js";
import { getTask, initStore } from "../src/core/store.js";
import { addWorktree, mergeWorktree, syncWorktree } from "../src/core/worktree.js";
import { tempRepo } from "./helpers.js";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const write = (cwd: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
};
const commit = (cwd: string, msg: string) => {
  run(cwd, "add", "-A");
  run(cwd, "commit", "-qm", msg);
};
const read = (cwd: string, file: string) => fs.readFileSync(path.join(cwd, file), "utf8");

function project() {
  const repo = tempRepo("agentbrain-cs-");
  write(repo, "app.ts", "one\ntwo\nthree\nfour\nfive\n");
  write(repo, ".gitignore", "node_modules/\n");
  commit(repo, "app");
  initStore(repo);
  return repo;
}

function task(repo: string, objective = "Change the app") {
  const t = addWorktree(repo, createTask(repo, objective).id);
  return { id: t.id, wt: t.worktree!.path };
}

describe("landing a result as a changeset", () => {
  it("merges each file against where the task started, so main's own edits to other lines stay", () => {
    const repo = project();
    const { id, wt } = task(repo);
    write(wt, "app.ts", "ONE\ntwo\nthree\nfour\nfive\n");
    commit(wt, "task edit");
    write(repo, "app.ts", "one\ntwo\nthree\nfour\nFIVE\n");
    commit(repo, "main edit");

    const result = mergeWorktree(repo, id);
    expect(result.conflicts).toEqual([]);
    expect(read(repo, "app.ts")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(run(repo, "log", "-1", "--format=%B")).toContain(`AgentBrain-Task: ${id}`);
    expect(run(repo, "status", "--porcelain", "--", ".", ":!.agentbrain")).toBe("");
    expect(getTask(repo, id).merged?.files).toEqual(["app.ts"]);
    expect(readChangesets(repo).at(-1)).toMatchObject({ task: id, files: [{ path: "app.ts", status: "M" }] });
  });

  it("lands only the task's own files after main's history was rewritten (a squash)", () => {
    const repo = project();
    write(repo, "extra.ts", "a\n");
    commit(repo, "extra");
    const { id, wt } = task(repo);
    write(wt, "feature.ts", "new\n");
    commit(wt, "feature");
    // Squash main's last commit into a different one: the task's starting point is no longer on main.
    run(repo, "reset", "-q", "--soft", "HEAD~1");
    write(repo, "extra.ts", "a\nb\n");
    commit(repo, "extra, squashed");

    const result = mergeWorktree(repo, id);
    expect(result.conflicts).toEqual([]);
    expect(read(repo, "feature.ts")).toBe("new\n");
    expect(read(repo, "extra.ts")).toBe("a\nb\n");
  });

  it("leaves out links out of the repository and never touches ignored folders", () => {
    const repo = project();
    write(repo, "node_modules/dep/index.js", "keep\n");
    const { id, wt } = task(repo);
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"));
    write(wt, "feature.ts", "new\n");
    run(wt, "add", "-f", "node_modules", "feature.ts");
    run(wt, "commit", "-qm", "feature, and a link by accident");

    const result = mergeWorktree(repo, id);
    expect(result.skipped).toEqual(["node_modules"]);
    expect(read(repo, "node_modules/dep/index.js")).toBe("keep\n");
    expect(fs.lstatSync(path.join(repo, "node_modules")).isSymbolicLink()).toBe(false);
    expect(read(repo, "feature.ts")).toBe("new\n");
  });

  it("keeps the developer's uncommitted work in other files", () => {
    const repo = project();
    write(repo, "notes.md", "draft\n");
    commit(repo, "notes");
    const { id, wt } = task(repo);
    write(wt, "app.ts", "ONE\ntwo\nthree\nfour\nfive\n");
    commit(wt, "task edit");
    write(repo, "notes.md", "draft, still being written\n");

    expect(mergeWorktree(repo, id).conflicts).toEqual([]);
    expect(read(repo, "notes.md")).toBe("draft, still being written\n");
    expect(read(repo, "app.ts")).toBe("ONE\ntwo\nthree\nfour\nfive\n");
  });

  it("changes nothing on conflict, then hands back markers in just the conflicting file", () => {
    const repo = project();
    write(repo, "other.ts", "x\n");
    commit(repo, "other");
    const { id, wt } = task(repo);
    write(wt, "app.ts", "one\nTWO (task)\nthree\nfour\nfive\n");
    write(wt, "other.ts", "x\ny\n");
    commit(wt, "task edit");
    write(repo, "app.ts", "one\nTWO (main)\nthree\nfour\nfive\n");
    write(repo, "main-only.ts", "m\n");
    commit(repo, "main edit");
    const before = run(repo, "rev-parse", "HEAD");

    const result = mergeWorktree(repo, id);
    expect(result.conflicts).toEqual(["app.ts"]);
    expect(run(repo, "rev-parse", "HEAD")).toBe(before);
    expect(run(repo, "status", "--porcelain", "--", ".", ":!.agentbrain")).toBe("");

    expect(syncWorktree(repo, id)).toEqual(["app.ts"]);
    expect(read(wt, "app.ts")).toMatch(/<<<<<<< main\nTWO \(main\)\n=======\nTWO \(task\)\n>>>>>>> task-/);
    expect(read(wt, "other.ts")).toBe("x\ny\n");
    expect(read(wt, "main-only.ts")).toBe("m\n");
    // Markers left in can't land.
    expect(mergeWorktree(repo, id).conflicts).toEqual(["app.ts"]);

    write(wt, "app.ts", "one\nTWO (both)\nthree\nfour\nfive\n");
    commit(wt, "resolve");
    expect(mergeWorktree(repo, id).conflicts).toEqual([]);
    expect(read(repo, "app.ts")).toBe("one\nTWO (both)\nthree\nfour\nfive\n");
    expect(read(repo, "other.ts")).toBe("x\ny\n");
  });

  it("an approved result that conflicts goes back with the markers already in its worktree", () => {
    const repo = project();
    setLead(repo, "claude-code");
    const { id, wt } = task(repo);
    write(wt, "app.ts", "one\nTWO (task)\nthree\nfour\nfive\n");
    commit(wt, "task edit");
    updateTask(repo, id, { status: "review", agent: { id: "codex", sessionId: "codex-1" } });
    write(repo, "app.ts", "one\nTWO (main)\nthree\nfour\nfive\n");
    commit(repo, "main edit");

    const result = reviewTask(repo, id, { verdict: "approved", reviewer: "claude-code" });
    expect(result.conflicts).toEqual(["app.ts"]);
    const back = getTask(repo, id);
    expect(back.status).toBe("handoff");
    expect(back.remaining[0]).toMatch(/conflict markers.*app\.ts/);
    expect(read(wt, "app.ts")).toContain("<<<<<<< main");
  });
});

describe("review rules", () => {
  it("tells docs, comment, test and code changes apart", () => {
    const none = () => false;
    expect(kindOf([{ path: "README.md", added: false }, { path: "docs/setup.txt", added: true }], none)).toBe("docs");
    expect(kindOf([{ path: "tests/a.test.ts", added: true }, { path: "README.md", added: false }], none)).toBe("tests");
    expect(kindOf([{ path: "src/a.ts", added: false }], () => true)).toBe("comments");
    expect(kindOf([{ path: "src/a.ts", added: true }], () => true)).toBe("code");
    expect(kindOf([{ path: "src/a.ts", added: false }, { path: "README.md", added: false }], none)).toBe("code");
  });

  it("lands a docs-only result without waiting for the lead", () => {
    const repo = project();
    setLead(repo, "claude-code");
    const { id, wt } = task(repo, "Document the app");
    write(wt, "docs/usage.md", "How to use it\n");
    commit(wt, "docs");
    updateTask(repo, id, { status: "review", agent: { id: "codex", sessionId: "codex-1" } });
    const done = getTask(repo, id);
    expect(done.status).toBe("done");
    expect(read(repo, "docs/usage.md")).toBe("How to use it\n");
  });

  it("lands a comment-only change, but not one that also changes code", () => {
    const repo = project();
    setLead(repo, "claude-code");
    write(repo, "calc.ts", "// adds\nexport const add = (a, b) => a + b;\n");
    commit(repo, "calc");
    const comments = task(repo, "Explain calc");
    write(comments.wt, "calc.ts", "// Adds two numbers.\nexport const add = (a, b) => a + b;\n");
    commit(comments.wt, "comment");
    updateTask(repo, comments.id, { status: "review", agent: { id: "codex", sessionId: "codex-1" } });
    expect(getTask(repo, comments.id).status).toBe("done");

    const code = task(repo, "Change calc");
    write(code.wt, "calc.ts", "// Adds two numbers.\nexport const add = (a, b) => a + b + 0;\n");
    commit(code.wt, "code");
    updateTask(repo, code.id, { status: "review", agent: { id: "codex", sessionId: "codex-2" } });
    expect(getTask(repo, code.id).status).toBe("review");
    expect(getTask(repo, code.id).review?.change?.kind).toBe("code");
  });

  it("protected files wait for the developer, whatever the lead votes", () => {
    const repo = project();
    setLead(repo, "claude-code");
    setReviewRules(repo, { protect: ["src/auth/"] });
    const { id, wt } = task(repo, "Change login");
    write(wt, "src/auth/login.ts", "export const login = 1;\n");
    commit(wt, "login");
    updateTask(repo, id, { status: "review", agent: { id: "codex", sessionId: "codex-1" } });
    expect(getTask(repo, id).review?.change?.protected).toEqual(["src/auth/login.ts"]);

    reviewTask(repo, id, { verdict: "approved", reviewer: "claude-code" });
    const waiting = getTask(repo, id);
    expect(waiting.status).toBe("review");
    expect(computeTally(repo, waiting).blocked).toMatch(/protected files need the developer/);

    reviewTask(repo, id, { verdict: "approved", reviewer: "developer" });
    expect(getTask(repo, id).status).toBe("done");
  });

  it("can be turned off", () => {
    const repo = project();
    setLead(repo, "claude-code");
    setReviewRules(repo, { autoApprove: [] });
    const { id, wt } = task(repo, "Document the app");
    write(wt, "README.md", "more\n");
    commit(wt, "docs");
    updateTask(repo, id, { status: "review", agent: { id: "codex", sessionId: "codex-1" } });
    expect(getTask(repo, id).status).toBe("review");
  });
});

describe("file history", () => {
  it("says which task and agent changed a file, and why", () => {
    const repo = project();
    const { id, wt } = task(repo, "Shout the first line");
    write(wt, "app.ts", "ONE\ntwo\nthree\nfour\nfive\n");
    commit(wt, "task edit");
    updateTask(repo, id, { decisions: ["Upper case reads better in logs"], agent: { id: "codex", sessionId: "codex-1" } });
    mergeWorktree(repo, id);

    const h = fileHistory(repo, path.join(repo, "app.ts"));
    expect(h.landed[0]).toMatchObject({ task: id, agent: "codex", objective: "Shout the first line" });
    const text = formatHistory(h);
    expect(text).toContain("why: Upper case reads better in logs");
    expect(text).toContain("Shout the first line");
  });
});
