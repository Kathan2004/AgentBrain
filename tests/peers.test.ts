import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTask } from "../src/core/actions.js";
import { addPeer, hubLink, joinHub, listPeers, localMachineData, remoteMachines, revokePeer, syncWithHub } from "../src/core/peers.js";
import { initStore } from "../src/core/store.js";
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
