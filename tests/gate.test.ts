import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { botId, gateCommand, gateIncoming, gateRef, guessBot } from "../src/core/gate.js";
import { getTask, initStore } from "../src/core/store.js";
import { tempRepo } from "./helpers.js";

function commit(repo: string, file: string, content: string, message: string) {
  fs.writeFileSync(path.join(repo, file), content);
  execFileSync("git", ["add", "--", file], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", message], { cwd: repo });
}

function branch(repo: string, name: string, from = "main") {
  execFileSync("git", ["checkout", "-q", "-b", name, from], { cwd: repo });
}

describe("botId", () => {
  it("slugifies a bot's name into a worker id", () => {
    expect(botId("dependabot[bot]")).toBe("dependabot-bot");
  });

  it("throws for a name with no safe characters", () => {
    expect(() => botId("!!!")).toThrow();
  });
});

describe("guessBot", () => {
  it("reads dependabot from a local branch name", () => {
    const repo = tempRepo("agentbrain-gate-");
    branch(repo, "dependabot/npm/x");
    expect(guessBot(repo, "dependabot/npm/x")).toBe("dependabot");
  });

  it("reads renovate from a remote-tracking branch name", () => {
    const repo = tempRepo("agentbrain-gate-");
    branch(repo, "renovate/y");
    expect(guessBot(repo, "origin/renovate/y")).toBe("renovate");
  });

  it("falls back to the ref's author for anything else", () => {
    const repo = tempRepo("agentbrain-gate-");
    branch(repo, "feature/x");
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Alice Dev", "-c", "user.email=a@a", "commit", "-qm", "work"], { cwd: repo });
    expect(guessBot(repo, "feature/x")).toBe("alice-dev");
  });
});

describe("gateRef", () => {
  function repoWithBotBranch(branchName: string) {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    branch(repo, branchName);
    commit(repo, "dep.js", "module.exports = 1;\n", "bump dep");
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
    return repo;
  }

  it("gates a local branch into a review task owned by the bot", () => {
    const repo = repoWithBotBranch("dependabot/npm/x");
    const task = gateRef(repo, "dependabot/npm/x");
    expect(task.status).toBe("review");
    expect(task.gated?.by).toBe("dependabot");
    expect(task.gated?.ref).toBe("dependabot/npm/x");
    expect(task.gated?.sha).toBeTruthy();
    expect(task.agent?.id).toBe("dependabot");
    expect(task.review?.worker).toBe("dependabot");
    expect(task.review?.votes).toEqual([]);
  });

  it("gating the same commit again returns the same task", () => {
    const repo = repoWithBotBranch("dependabot/npm/y");
    const first = gateRef(repo, "dependabot/npm/y");
    const again = gateRef(repo, "dependabot/npm/y");
    expect(again.id).toBe(first.id);
    expect(getTask(repo, first.id).id).toBe(first.id);
  });

  it("throws for an unknown ref", () => {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    expect(() => gateRef(repo, "no-such-ref")).toThrow();
  });

  it("throws for a ref already in HEAD", () => {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    expect(() => gateRef(repo, "main")).toThrow();
  });
});

describe("gateCommand", () => {
  it("opens a review when the command edits a file", () => {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    const command = "printf 'const x = 1;\\n' >> app.js";
    const task = gateCommand(repo, command);
    expect(task.status).toBe("review");
    expect(task.gated?.command).toBe(command);
    expect(task.gated?.sha).toBeTruthy();
  });

  it("closes the task as done when the command changes nothing", () => {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    const task = gateCommand(repo, "true");
    expect(task.status).toBe("done");
  });

  it("blocks the task with the failure when the command exits non-zero", () => {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    const task = gateCommand(repo, "exit 1");
    expect(task.status).toBe("blocked");
    expect(task.failures.length).toBeGreaterThan(0);
  });
});

describe("gateIncoming", () => {
  /** A clone of `repo` (so the histories are related) with a bot's branch on it. */
  function remoteWithBranch(repo: string, branchName: string, file: string) {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-gate-remote-"));
    execFileSync("git", ["clone", "-q", repo, remote]);
    branch(remote, branchName);
    commit(remote, file, "1\n", `bump ${file}`);
    execFileSync("git", ["checkout", "-q", "-"], { cwd: remote });
    return remote;
  }

  it("gates a new dependabot branch from the remote once", () => {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    const remote = remoteWithBranch(repo, "dependabot/npm/lodash", "lodash.js");
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });

    const gated = gateIncoming(repo);
    expect(gated).toHaveLength(1);
    expect(gated[0].gated?.by).toBe("dependabot");
    expect(gated[0].gated?.ref).toBe("origin/dependabot/npm/lodash");
    expect(gated[0].status).toBe("review");

    expect(gateIncoming(repo)).toEqual([]);
  });

  it("ignores a branch that doesn't match a bot pattern", () => {
    const repo = tempRepo("agentbrain-gate-");
    initStore(repo);
    const remote = remoteWithBranch(repo, "feature/x", "x.txt");
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });

    expect(gateIncoming(repo)).toEqual([]);
  });
});
