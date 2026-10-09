import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { requestStop, sendToSession } from "../core/headless.js";
import { taskTimeline } from "../core/timeline.js";
import { findSession, getProject, listTasks } from "../core/store.js";
import { readNote, vaultGraph, writeVault } from "../core/vault.js";
import { snapshot, taskDiff, transcriptTail, watchProject, type LiveTask } from "./model.js";
import { openInEditor } from "./open.js";
import { PAGE } from "./page.js";
import { reviewTask, setChecks, setCouncil, setLead, startVerification } from "../core/review.js";
import { delegate, setDefaultWorker } from "../core/delegate.js";
import { openUrl } from "../core/platform.js";

export interface UiServer {
  url: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(PAGE);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("request body too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function findTask(root: string, taskId: string): LiveTask {
  const task = snapshot(root, { includeDone: true }).tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found.`);
  return task;
}

function dashboardUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? ""}`);
}

export async function startUiServer(
  root: string,
  options: { port?: number; token?: string; self?: { command: string; args: string[] } } = {},
): Promise<UiServer> {
  const token = options.token && /^[0-9a-f]{48}$/.test(options.token) ? options.token : randomBytes(24).toString("hex");
  const clients = new Set<ServerResponse>();
  let server: Server;
  let actualPort = options.port ?? 4747;
  const origin = () => `http://127.0.0.1:${actualPort}`;
  const allowedHost = (host: string | undefined) => host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}`;
  const authorized = (request: IncomingMessage, url: URL): boolean => {
    const headerToken = request.headers["x-agentbrain-token"];
    const queryToken = url.pathname === "/api/events" ? url.searchParams.get("token") : null;
    const given = typeof headerToken === "string" ? headerToken : queryToken;
    return allowedHost(request.headers.host) && typeof given === "string" && given.length === token.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };
  // Results submitted by agents connected through an older AgentBrain (or set to review by
  // hand) never had their checks started: the control room starts them, once per submission.
  const verifying = new Set<string>();
  const autoVerify = () => {
    if (!options.self) return;
    try {
      if (!getProject(root).checks?.length) return;
      for (const task of listTasks(root)) {
        if (task.status !== "review" || task.review?.verifiedAt) continue;
        const key = `${task.id}@${task.review?.requestedAt ?? task.updatedAt}`;
        if (verifying.has(key)) continue;
        verifying.add(key);
        startVerification(root, task.id);
      }
    } catch {
      // never let this break the dashboard
    }
  };
  let lastSent = "";
  let vaultTimer: NodeJS.Timeout | undefined;
  const sendEvent = () => {
    autoVerify();
    if (vaultTimer) clearTimeout(vaultTimer);
    vaultTimer = setTimeout(() => {
      vaultTimer = undefined;
      try { writeVault(root); } catch {}
    }, 250);
    if (!clients.size) return;
    const data = JSON.stringify(snapshot(root, { includeDone: true }));
    // The watcher also polls; don't redraw browsers when nothing changed.
    if (data === lastSent) return;
    lastSent = data;
    for (const client of clients) client.write(`event: snapshot\ndata: ${data}\n\n`);
  };
  const stopWatching = watchProject(root, sendEvent);

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    let url: URL;
    try { url = dashboardUrl(request); } catch { response.writeHead(400).end(); return; }
    const isApi = url.pathname.startsWith("/api/");
    if (isApi && !authorized(request, url)) { response.writeHead(403).end("Forbidden"); return; }
    if (request.method === "POST" && request.headers.origin && request.headers.origin !== origin()) {
      response.writeHead(403).end("Forbidden"); return;
    }
    try {
      if (url.pathname === "/" && request.method === "GET") return html(response);
      if (url.pathname === "/api/snapshot" && request.method === "GET") return json(response, snapshot(root, { includeDone: true }));
      if (url.pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(root, { includeDone: true }))}\n\n`);
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (url.pathname === "/api/diff" && request.method === "GET") return json(response, { diff: taskDiff(findTask(root, url.searchParams.get("task") ?? "").workdir) });
      if (url.pathname === "/api/vault" && request.method === "GET") return json(response, vaultGraph(root));
      if (url.pathname === "/api/note" && request.method === "GET") return json(response, { id: url.searchParams.get("id"), markdown: readNote(root, url.searchParams.get("id") ?? "") });
      if (url.pathname === "/api/log" && request.method === "GET") return json(response, taskTimeline(root, url.searchParams.get("task") ?? ""));
      if (url.pathname === "/api/transcript" && request.method === "GET") {
        const session = findSession(root, url.searchParams.get("session") ?? "");
        return json(response, { transcript: transcriptTail(session?.transcript) });
      }
      if (request.method === "POST" && url.pathname === "/api/policy") {
        const body = JSON.parse(await readBody(request)) as { mode: string; agents?: string[]; quorum?: number };
        if (body.mode === "lead") setLead(root, body.agents?.[0] ?? null);
        else if (body.mode === "council") setCouncil(root, body.agents ?? [], body.quorum);
        else { setLead(root, null); setCouncil(root, null); }
        return json(response, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/delegate") {
        const body = JSON.parse(await readBody(request)) as { prompt?: string; taskId?: string; worker?: string };
        if (!options.self) throw new Error("This control room can't start agents; run it with `agentbrain on`.");
        if (!body.taskId && !body.prompt?.trim()) throw new Error("Say what you want done.");
        const result = delegate(root, { prompt: body.prompt?.trim(), taskId: body.taskId, worker: body.worker }, options.self);
        return json(response, { ok: true, taskId: result.task.id, worker: result.worker.name });
      }
      if (request.method === "POST" && url.pathname === "/api/verify") {
        const body = JSON.parse(await readBody(request)) as { taskId: string };
        startVerification(root, findTask(root, body.taskId).id);
        return json(response, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        const body = JSON.parse(await readBody(request)) as { worker?: string; checks?: string[] };
        if (body.worker) setDefaultWorker(root, body.worker);
        if (body.checks) setChecks(root, body.checks.map((c) => c.trim()).filter(Boolean));
        return json(response, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/review") {
        const body = JSON.parse(await readBody(request)) as { taskId: string; verdict: string; notes?: string };
        if (body.verdict !== "approved" && body.verdict !== "changes") throw new Error("verdict must be approved or changes");
        // The person at the dashboard is the developer: their verdict decides (an override).
        const result = reviewTask(root, body.taskId, { verdict: body.verdict, reviewer: "developer", notes: body.notes });
        return json(response, { ok: true, outcome: result.outcome, conflicts: result.conflicts });
      }
      if (request.method === "POST" && ["/api/message", "/api/stop", "/api/open", "/api/open-vault"].includes(url.pathname)) {
        const body = JSON.parse(await readBody(request)) as Record<string, string>;
        if (url.pathname === "/api/open-vault") {
          openUrl(vaultGraph(root).dir);
          return json(response, { ok: true });
        }
        if (url.pathname === "/api/open") {
          openInEditor(findTask(root, body.taskId).workdir);
        } else {
          const session = findSession(root, body.sessionId);
          if (!session) throw new Error("Session not found.");
          if (url.pathname === "/api/message") {
            if (!body.text?.trim()) throw new Error("Message text is required.");
            sendToSession(root, session.agentId, session.sessionId, body.text);
          } else requestStop(root, session.agentId, session.sessionId);
        }
        return json(response, { ok: true });
      }
      response.writeHead(404).end("Not found");
    } catch (error) {
      json(response, { error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };

  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && options.port === undefined) {
        // Default port busy: take any free one, and check requests against it.
        server.listen(0, "127.0.0.1", () => {
          actualPort = (server.address() as { port: number }).port;
          resolve();
        });
      } else reject(error);
    };
    server.once("error", onError);
    server.listen(actualPort, "127.0.0.1", () => {
      actualPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
  return {
    url: `${origin()}/#token=${token}`,
    close: async () => {
      stopWatching();
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
