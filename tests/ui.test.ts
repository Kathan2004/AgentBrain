import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startUiServer } from "../src/ui/server.js";
import { createTask } from "../src/core/actions.js";
import { initStore, saveSession } from "../src/core/store.js";
import { sessionControl } from "../src/core/headless.js";
import { addToQueue } from "../src/core/queue.js";
import { tempRepo } from "./helpers.js";

async function request(base: string, route: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${route}`, options);
}

function requestWithHost(port: string, host: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/api/snapshot", headers: { host, "x-agentbrain-token": token } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("local UI server", () => {
  it("protects and serves the live dashboard APIs", async () => {
    const repo = tempRepo("agentbrain-ui-");
    initStore(repo);
    const task = createTask(repo, "Build the live dashboard");
    const queued = createTask(repo, "Queued dashboard follow-up");
    addToQueue(repo, [queued.id]);
    const sessionId = "ui-session";
    saveSession(repo, {
      schemaVersion: "0.1",
      agentId: "test-agent",
      sessionId,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      mode: "headless",
      pid: process.pid,
      transcript: path.join(repo, "transcript.log"),
    });
    const server = await startUiServer(repo, { port: 0 });
    try {
      const url = new URL(server.url);
      const base = `http://127.0.0.1:${url.port}`;
      const token = url.hash.slice("#token=".length);
      expect((await request(base, "/api/snapshot")).status).toBe(403);
      expect(await requestWithHost(url.port, `example.com:${url.port}`, token)).toBe(403);
      const snapshot = await (await request(base, "/api/snapshot", { headers: { "x-agentbrain-token": token } })).json() as { tasks: { id: string }[]; queue: { id: string; objective: string; status: string }[] };
      expect(snapshot.tasks.map((item) => item.id)).toContain(task.id);
      expect(snapshot.queue).toEqual([{ id: queued.id, objective: "Queued dashboard follow-up", status: "idle" }]);
      const message = await request(base, "/api/message", {
        method: "POST",
        headers: { "x-agentbrain-token": token },
        body: JSON.stringify({ sessionId, text: "Please continue" }),
      });
      expect(message.status).toBe(200);
      expect(fs.readFileSync(sessionControl(repo, "test-agent", sessionId).inbox, "utf8")).toContain("Please continue");
      const page = await request(base, "/");
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("AgentBrain");
      expect(html).toContain('data-open="\'+esc(t.id)+\'"');
    } finally {
      await server.close();
    }
  });

  it("falls back to a free port when the default is busy, and still accepts its own token", async () => {
    const repo = tempRepo("agentbrain-ui-");
    initStore(repo);
    createTask(repo, "Port fallback");
    const blocker = http.createServer(() => {});
    await new Promise<void>((resolve) => blocker.once("error", () => resolve()).listen(4747, "127.0.0.1", () => resolve()));
    const server = await startUiServer(repo);
    try {
      const url = new URL(server.url);
      expect(url.port).not.toBe("4747");
      const token = url.hash.replace("#token=", "");
      const response = await request(url.origin, "/api/snapshot", { headers: { "x-agentbrain-token": token } });
      expect(response.status).toBe(200);
      expect((await response.json()).tasks[0].objective).toBe("Port fallback");
      expect((await request(url.origin, "/api/snapshot", { headers: { "x-agentbrain-token": "x".repeat(48) } })).status).toBe(403);
    } finally {
      await server.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
