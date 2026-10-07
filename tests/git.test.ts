import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getGitState, parsePorcelainZ } from "../src/core/git.js";

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function commitAll(dir: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], { cwd: dir });
}

describe("parsePorcelainZ", () => {
  it("keeps the full path of the first entry", () => {
    expect(parsePorcelainZ(" M a.txt\0?? src/auth.ts\0")).toEqual(["a.txt", "src/auth.ts"]);
  });

  it("reports the new path of a rename and skips the original", () => {
    expect(parsePorcelainZ("R  new.ts\0old.ts\0 M other.ts\0")).toEqual(["new.ts", "other.ts"]);
  });

  it("handles paths with spaces", () => {
    expect(parsePorcelainZ("?? my file.txt\0")).toEqual(["my file.txt"]);
  });
});

describe("getGitState", () => {
  it("works in a repository with no commits", () => {
    const dir = tempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    expect(getGitState(dir)).toEqual({ head: null, branch: "main", dirty: true, changedFiles: ["a.txt"] });
  });

  it("ignores AgentBrain's own state directory", () => {
    const dir = tempRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    commitAll(dir);
    fs.mkdirSync(path.join(dir, ".agentbrain"));
    fs.writeFileSync(path.join(dir, ".agentbrain", "project.json"), "{}");
    const state = getGitState(dir);
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
    expect(state.dirty).toBe(false);
    expect(state.changedFiles).toEqual([]);
  });

  it("rejects a directory that is not a repository", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-nogit-"));
    expect(() => getGitState(dir)).toThrow("requires a Git repository");
  });
});
