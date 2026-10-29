import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/actions.js";
import { delegate } from "../src/core/delegate.js";
import { collectResults, serveJobs } from "../src/core/remote.js";
import { pendingReviews } from "../src/core/review.js";
import { addPeer, hubLink, joinHub, listPeers, localMachineData, readJobs, writeJobs, remoteMachines, revokePeer, syncWithHub } from "../src/core/peers.js";
import { getTask, initStore } from "../src/core/store.js";
import { startUiServer } from "../src/ui/server.js";
import { tempRepo } from "./helpers.js";

describe("peers", () => {
  it("syncs tasks both ways through a shared hub, and revoking cuts a peer off", async () => {
    const hub = tempRepo("ab-hub-"); initStore(hub); createTask(hub, "Hub task");
    const peer = tempRepo("ab-peer-"); initStore(peer); createTask(peer, "Peer task");
    const server = await startUiServer(hub, { port: 0, share: true });
    const url = server.url.split("#")[0];
    try {
      const { token } = addPeer(hub, "laptop");
      expect(fs.readFileSync(path.join(hub, ".agentbrain", "peers.json"), "utf8")).not.toContain(token);
      expect((await fetch(`${url}api/peer/sync`, { method: "POST", body: "{}", headers: { "x-agentbrain-peer": "0".repeat(48) } })).status).toBe(403);
      joinHub(peer, url, token);
      expect(hubLink(peer)?.url).toBe(url.replace(/\/$/, ""));
      expect(await syncWithHub(peer)).toBe(1);
      expect(remoteMachines(peer)[0].tasks.map((t) => t.objective)).toContain("Hub task");
      expect(remoteMachines(hub).map((m) => m.machine)).toEqual(["laptop"]);
      expect(remoteMachines(hub)[0].tasks.map((t) => t.objective)).toContain("Peer task");
      expect(listPeers(hub)[0].lastSeen).toBeTruthy();
      expect(revokePeer(hub, "laptop")).toBe(true);
      await expect(syncWithHub(peer)).rejects.toThrow(/rejected/);
      expect(remoteMachines(hub)).toEqual([]);
    } finally { await server.close(); }
  });

  it("redacts secrets before anything leaves the machine", () => {
    const peer = tempRepo("ab-peer-"); initStore(peer);
    createTask(peer, `Use ghp_${"a".repeat(36)} to push`);
    expect(JSON.stringify(localMachineData(peer))).not.toContain("ghp_a");
  });

  it("rejects bad machine names and duplicates", () => {
    const hub = tempRepo("ab-hub-"); initStore(hub);
    expect(() => addPeer(hub, "../x")).toThrow();
    addPeer(hub, "a");
    expect(() => addPeer(hub, "a")).toThrow(/already exists/);
  });
});

describe("remote work", () => {
  it("runs a task on another machine, which pushes a branch the originator fetches for review", async () => {
    const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    const hub = tempRepo("ab-hub-"); initStore(hub);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ab-origin-"));
    sh(bare, "init", "-q", "--bare");
    sh(hub, "remote", "add", "origin", bare); sh(hub, "push", "-q", "origin", "main");
    const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-clone-"));
    sh(peerDir, "clone", "-q", bare, "."); initStore(peerDir);
    const server = await startUiServer(hub, { port: 0, share: true });
    const self = { command: "true", args: [] };
    // One process plays both machines, so the peer only takes its name while it serves jobs.
    const serve = (dir: string) => { process.env.AGENTBRAIN_MACHINE = "laptop"; try { serveJobs(dir, self); } finally { delete process.env.AGENTBRAIN_MACHINE; } };
    try {
      const { token } = addPeer(hub, "laptop");
      joinHub(peerDir, server.url.split("#")[0], token);
      await syncWithHub(peerDir);
      const { task } = delegate(hub, { prompt: "Add a file", worker: "laptop:any" }, self);
      await syncWithHub(peerDir);
      serve(peerDir);
      expect(readJobs(peerDir).taken).toEqual({}); // not accepting yet
      writeJobs(peerDir, { ...readJobs(peerDir), accept: true });
      serve(peerDir);
      const [taken] = Object.values(readJobs(peerDir).taken);
      const wt = getTask(peerDir, taken).worktree!.path;
      fs.writeFileSync(path.join(wt, "new.txt"), "hi\n");
      sh(wt, "add", "-A"); sh(wt, "commit", "-qm", "Add file");
      const mainBefore = sh(peerDir, "rev-parse", "main").trim();
      updateTask(peerDir, taken, { status: "review" });
      expect(pendingReviews(peerDir)).toEqual([]); // never reviewed on the machine that worked for another
      serve(peerDir);
      const closed = getTask(peerDir, taken);
      expect(closed.status).toBe("done");
      expect(closed.nextAction).toMatch(/^Returned to .* as agentbrain\/remote\//);
      expect(closed.objective).toMatch(/^From /);
      expect(sh(peerDir, "rev-parse", "main").trim()).toBe(mainBefore);
      await syncWithHub(peerDir);
      collectResults(hub);
      const done = getTask(hub, task.id);
      expect(done.status).toBe("review");
      expect(done.review?.worker).toBe("laptop:any");
      expect(fs.readFileSync(path.join(done.worktree!.path, "new.txt"), "utf8")).toBe("hi\n");
    } finally { await server.close(); }
  }, 30_000);
});
