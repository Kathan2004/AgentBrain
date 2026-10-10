import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initStore } from "../src/core/store.js";
import { gitGraph, layoutGraph, webUrl, type GraphCommit } from "../src/ui/gitgraph.js";
import { chatPrompt } from "../src/ui/server.js";
import { tempRepo } from "./helpers.js";

const c = (hash: string, parents: string[]): GraphCommit => ({ hash, parents, author: "t", at: "", subject: hash, refs: [] });

describe("git graph layout", () => {
  it("keeps a straight line in one lane", () => {
    const { rows, width } = layoutGraph([c("c", ["b"]), c("b", ["a"]), c("a", [])]);
    expect(width).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[2].out).toEqual([]);
  });

  it("opens a lane for a branch and joins it back at the fork point", () => {
    // m merges b2 into a1; both come from root.
    const { rows, width } = layoutGraph([c("m", ["a1", "b2"]), c("b2", ["b1"]), c("a1", ["root"]), c("b1", ["root"]), c("root", [])]);
    expect(width).toBe(2);
    expect(rows[0]).toMatchObject({ lane: 0, out: [0, 1] });
    expect(rows[1].lane).toBe(1);
    expect(rows[2].lane).toBe(0);
    // b1's parent already has lane 0, so its line curves into it and lane 1 closes.
    expect(rows[3]).toMatchObject({ lane: 1, out: [0] });
    expect(rows[4].into).toEqual([0]);
  });
});

describe("remote web address", () => {
  it("turns ssh and https remotes into a web URL without credentials", () => {
    expect(webUrl("git@github.com:Kathan2004/AgentBrain.git")).toBe("https://github.com/Kathan2004/AgentBrain");
    expect(webUrl("https://user:secret@github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(webUrl("/some/local/path")).toBeNull();
    expect(webUrl("")).toBeNull();
  });
});

describe("gitGraph", () => {
  it("reads history, the working tree and worktrees of a repository without a remote", async () => {
    const repo = tempRepo("agentbrain-graph-");
    initStore(repo);
    fs.writeFileSync(path.join(repo, "new.txt"), "x\n");
    const g = await gitGraph(repo);
    expect(g.commits.length).toBeGreaterThan(0);
    expect(g.remoteName).toBeNull();
    expect(g.commits.every((x) => !x.local)).toBe(true);
    expect(g.changes.some((x) => x.path === "new.txt")).toBe(true);
    expect(g.worktrees[0].path).toBe(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim());
  });
});

describe("chat history", () => {
  it("sends the conversation so far with the new message", () => {
    expect(chatPrompt("hi")).toBe("hi");
    const p = chatPrompt("What is my name?", [{ role: "user", text: "I am Kathan" }, { role: "assistant", text: "Hello Kathan" }]);
    expect(p).toContain("User: I am Kathan");
    expect(p).toContain("You: Hello Kathan");
    expect(p.endsWith("What is my name?")).toBe(true);
  });
});
