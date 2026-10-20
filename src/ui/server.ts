import { diskEditRecorder } from "../core/diskedits.js";
import { focusReviewers, setFocus } from "../core/focus.js";
import { auditFile, auditTrail, formatAudit, formatFileAudit } from "../core/audit.js";
import { setModels, TIER_PLATFORMS } from "../core/models.js";
import { fileHistory } from "../core/history.js";
import { gateSweep } from "../core/gate.js";
import { setReviewRules, type ChangeKind } from "../core/reviewrules.js";
import { watchTranscripts } from "../core/transcripts.js";
import { CLOSE_REASONS, closeTask } from "../core/close.js";
import { readActivity } from "../core/activity.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { requestStop, sendToSession } from "../core/headless.js";
import { updateTask } from "../core/actions.js";
import { taskTimeline } from "../core/timeline.js";
import { findSession, getProject, getTask, listTasks } from "../core/store.js";
import { readNote, vaultGraph, writeVault } from "../core/vault.js";
import { snapshot, taskChanges, taskDiff, transcriptTail, watchProject, type LiveTask } from "./model.js";
import { openInEditor } from "./open.js";
import { PAGE } from "./page.js";
import { gitFetch, gitGraph, gitToday } from "./gitgraph.js";
import { retryPendingMerges, reviewTask, settleReviews, setChecks, setCouncil, setLead, startVerification } from "../core/review.js";
import { setPermissionMode } from "../core/permissions.js";
import { standInSweep } from "../core/standin.js";
import { rescueStalledChats, resumeSentBack } from "../core/rescue.js";
import { chatBrief, sharedContext } from "../core/context.js";
import { claudeBinary, codexBinary, delegate, setDefaultWorker } from "../core/delegate.js";
import { printAgent, runChat } from "../core/printrun.js";
import { openUrl } from "../core/platform.js";
import { connectConnector, detectConnectors, disconnectConnector } from "../core/connectors.js";

/** Each chat message runs a fresh agent, so the conversation so far rides along with the new message. */
export function chatPrompt(prompt: string, history: { role?: string; text?: string }[] = []): string {
  const turns = (Array.isArray(history) ? history : []).slice(-12)
    .filter((m) => typeof m?.text === "string" && m.text.trim())
    .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text!.trim().slice(0, 2000)}`);
  return turns.length ? `Conversation so far:\n${turns.join("\n\n")}\n\nThe user's new message:\n${prompt}` : prompt;
}

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

function outsideRoot(root: string, file: string): boolean {
  const rel = path.relative(root, path.resolve(root, file));
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
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
  options: {
    port?: number;
    token?: string;
    /** How to start AgentBrain in the background (delegation). */
    self?: { command: string; args: string[] };
    /** How agents' config files should start AgentBrain (connectors). */
    config?: { command: string; args: string[] };
  } = {},
): Promise<UiServer> {
  const token = options.token && /^[0-9a-f]{48}$/.test(options.token) ? options.token : randomBytes(24).toString("hex");
  const clients = new Set<ServerResponse>();
  let server: Server;
  let actualPort = options.port ?? 4747;
  const origin = () => `http://127.0.0.1:${actualPort}`;
  const allowedHost = (host: string | undefined) => host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}`;
  const tokenBuf = Buffer.from(token);
  const authorized = (request: IncomingMessage, url: URL): boolean => {
    const headerToken = request.headers["x-agentbrain-token"];
    const queryToken = url.pathname === "/api/events" ? url.searchParams.get("token") : null;
    const given = typeof headerToken === "string" ? headerToken : queryToken;
    if (!allowedHost(request.headers.host) || typeof given !== "string") return false;
    // Compare byte length, not string length: a multi-byte character can keep
    // the string length equal while its UTF-8 encoding differs, which would
    // otherwise make timingSafeEqual throw (and crash the server) instead of
    // just failing the check.
    const givenBuf = Buffer.from(given);
    return givenBuf.length === tokenBuf.length && timingSafeEqual(givenBuf, tokenBuf);
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
  // Close only tasks whose own record explicitly says they were accidental.
  // A failed or idle task is otherwise left alone: status alone is not evidence
  // that its work can be discarded.
  const autoCloseAccidental = () => {
    if (!options.self) return;
    try {
      for (const task of listTasks(root)) {
        if (task.status !== "failed" || !task.failures.some((failure) => /accidental|created by mistake/i.test(failure))) continue;
        closeTask(root, task.id, "Closed automatically: accidental task", "Closed automatically");
      }
    } catch {
      // never let cleanup break the dashboard
    }
  };
  // A lead that did the work itself, is out of quota or stays silent would stall every
  // result: another agent stands in (checked at most once a minute).
  let lastStandIn = 0;
  const autoStandIn = () => {
    if (!options.self || Date.now() - lastStandIn < 60_000) return;
    lastStandIn = Date.now();
    try { standInSweep(root, options.self); } catch { /* never break the dashboard */ }
    try { rescueStalledChats(root, options.self); } catch { /* same */ }
    try { resumeSentBack(root, options.self); } catch { /* same */ }
    try { retryPendingMerges(root); } catch { /* same */ }
    try { settleReviews(root); } catch { /* same */ }
    try { gateSweep(root); } catch { /* same: a fetch can fail offline */ }
  };
  let lastSent = "";
  let vaultTimer: NodeJS.Timeout | undefined;
  const sendEvent = () => {
    autoVerify();
    autoCloseAccidental();
    autoStandIn();
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
  // Edits from editors without hooks (Cursor, Copilot, by hand) show up in Activity too.
  const diskEdits = diskEditRecorder(root);
  const stopWatching = watchProject(root, sendEvent, diskEdits.changed);
  // Agents without hooks: follow the transcripts they keep on disk.
  const stopTranscripts = process.env.VITEST ? () => {} : watchTranscripts(root);

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
      if (url.pathname === "/api/context" && request.method === "GET") {
        const task = getTask(root, findTask(root, url.searchParams.get("task") ?? "").id);
        return json(response, { context: sharedContext(root, { taskId: task.id, objective: task.objective }) });
      }
      if (url.pathname === "/api/audit" && request.method === "GET") {
        const file = url.searchParams.get("file");
        if (file) {
          if (outsideRoot(root, file)) return json(response, { error: "Path outside repository" }, 400);
          return json(response, { text: formatFileAudit(root, file, auditFile(root, file)) });
        }
        return json(response, { text: formatAudit(auditTrail(root)) });
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        const file = url.searchParams.get("file");
        if (file && outsideRoot(root, file)) return json(response, { error: "Path outside repository" }, 400);
        return json(response, fileHistory(root, file ?? ""));
      }
      if (url.pathname === "/api/changes" && request.method === "GET") return json(response, await taskChanges(root, getTask(root, findTask(root, url.searchParams.get("task") ?? "").id)));
      if (url.pathname === "/api/connectors" && request.method === "GET") return json(response, detectConnectors(root, { all: url.searchParams.get("all") === "1" }));
      if (request.method === "POST" && (url.pathname === "/api/connectors/connect" || url.pathname === "/api/connectors/disconnect")) {
        const body = JSON.parse(await readBody(request)) as { id: string };
        if (url.pathname.endsWith("/disconnect")) return json(response, { ok: true, changed: disconnectConnector(root, body.id) });
        const cmd = options.config ?? options.self ?? { command: "agentbrain", args: [] };
        return json(response, { ok: true, ...connectConnector(root, body.id, cmd.command, [...cmd.args, "mcp"]) });
      }
      if (url.pathname === "/api/git" && request.method === "GET") return json(response, await gitGraph(root));
      if (url.pathname === "/api/git/fetch" && request.method === "POST") return json(response, await gitFetch(root));
      if (url.pathname === "/api/vault" && request.method === "GET") return json(response, vaultGraph(root));
      if (url.pathname === "/api/note" && request.method === "GET") return json(response, { id: url.searchParams.get("id"), markdown: readNote(root, url.searchParams.get("id") ?? "") });
      if (url.pathname === "/api/activity" && request.method === "GET") {
        // A task's whole feed history: the snapshot carries only the latest events.
        const id = findTask(root, url.searchParams.get("task") ?? "").id;
        return json(response, readActivity(root, 20_000).filter((e) => e.task === id).slice(-300));
      }
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
        const result = delegate(root, { prompt: body.prompt?.trim(), taskId: body.taskId, worker: body.worker, ...(body.taskId ? {} : { requestedBy: "developer" }) }, options.self);
        return json(response, { ok: true, taskId: result.task.id, worker: result.worker.name });
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = JSON.parse(await readBody(request)) as { prompt?: string; worker?: string; history?: { role?: string; text?: string }[] };
        if (!body.prompt?.trim()) throw new Error("Say something to chat about.");
        const agent = printAgent(body.worker ?? "", root);
        const commitsToday = await gitToday(root);
        const prompt = `${chatBrief(root, body.prompt, commitsToday)}\n\n${chatPrompt(body.prompt.trim(), body.history)}`;
        if (!String(request.headers.accept ?? "").includes("application/x-ndjson")) {
          // A page from before streaming: answer in one piece.
          const output: string[] = [];
          await runChat(root, agent, prompt, (text) => output.push(text));
          return json(response, { ok: true, worker: agent.id, text: output.join("") });
        }
        // Streamed as JSON lines, so the answer shows up while the model is still writing it.
        response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        const write = (value: unknown) => response.write(`${JSON.stringify(value)}\n`);
        try {
          await runChat(root, agent, prompt, (text) => write({ text }));
          write({ done: true, worker: agent.id });
        } catch (error) {
          write({ error: error instanceof Error ? error.message : String(error) });
        }
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/verify") {
        const body = JSON.parse(await readBody(request)) as { taskId: string };
        startVerification(root, findTask(root, body.taskId).id);
        return json(response, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/close") {
        const body = JSON.parse(await readBody(request)) as { taskId: string; reason?: string };
        const task = findTask(root, body.taskId);
        const reason = body.reason?.trim();
        if (!reason || !CLOSE_REASONS.includes(reason)) throw new Error(`Choose one of: ${CLOSE_REASONS.join(", ")}.`);
        closeTask(root, task.id, `Closed manually: ${reason}`);
        return json(response, { ok: true, reason });
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        const body = JSON.parse(await readBody(request)) as {
          worker?: string; checks?: string[]; permissions?: string;
          autoApprove?: string[]; protect?: string[]; focus?: { agent: string; area: string; paths?: string[] }[];
          models?: Record<string, { lead?: string; workers: { name: string; model: string }[]; use?: string[] }>;
        };
        // Validate every platform's tiers before saving any of them.
        if (body.models) for (const platform of Object.keys(body.models)) if (!(TIER_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`Model tiers work with ${TIER_PLATFORMS.join(" and ")}.`);
        if (body.worker) setDefaultWorker(root, body.worker);
        if (body.permissions === "all" || body.permissions === "ask") {
          const result = setPermissionMode(root, body.permissions);
          if (result.warning) return json(response, { ok: true, warning: result.warning });
        }
        if (body.checks) setChecks(root, body.checks.map((c) => c.trim()).filter(Boolean));
        if (body.autoApprove || body.protect) {
          setReviewRules(root, {
            ...(body.autoApprove ? { autoApprove: body.autoApprove as ChangeKind[] } : {}),
            ...(body.protect ? { protect: body.protect.map((p) => p.trim()).filter(Boolean) } : {}),
          });
        }
        if (body.focus) {
          // The list replaces the current focus reviewers.
          for (const f of focusReviewers(root)) if (!body.focus.some((x) => x.agent === f.agent)) setFocus(root, f.agent, null);
          for (const f of body.focus.filter((x) => x.agent && x.area?.trim())) setFocus(root, f.agent, f.area, (f.paths ?? []).map((p) => p.trim()).filter(Boolean));
        }
        if (body.models) for (const [platform, m] of Object.entries(body.models)) setModels(root, platform, { ...(m.lead ? { lead: m.lead } : {}), workers: m.workers ?? [], ...(m.use?.length ? { use: m.use } : {}) });
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
      // A stream that already started (live updates) can't get an error reply; just close it.
      if (response.headersSent) { response.end(); return; }
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
      diskEdits.stop();
      stopTranscripts();
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
