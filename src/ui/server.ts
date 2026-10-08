import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { requestStop, sendToSession } from "../core/headless.js";
import { taskTimeline } from "../core/timeline.js";
import { findSession } from "../core/store.js";
import { snapshot, taskDiff, transcriptTail, watchProject, type LiveTask } from "./model.js";
import { openInEditor } from "./open.js";

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

export async function startUiServer(root: string, options: { port?: number } = {}): Promise<UiServer> {
  const token = randomBytes(24).toString("hex");
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
  let lastSent = "";
  const sendEvent = () => {
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
      if (url.pathname === "/api/log" && request.method === "GET") return json(response, taskTimeline(root, url.searchParams.get("task") ?? ""));
      if (url.pathname === "/api/transcript" && request.method === "GET") {
        const session = findSession(root, url.searchParams.get("session") ?? "");
        return json(response, { transcript: transcriptTail(session?.transcript) });
      }
      if (request.method === "POST" && ["/api/message", "/api/stop", "/api/open"].includes(url.pathname)) {
        const body = JSON.parse(await readBody(request)) as Record<string, string>;
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

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentBrain</title>
<style>
:root{color-scheme:light dark;--bg:#f4f1ea;--panel:#fffdf8;--ink:#20231f;--muted:#72766d;--line:#d8d5ca;--accent:#d65b38} @media(prefers-color-scheme:dark){:root{--bg:#171916;--panel:#22251f;--ink:#f3f0e7;--muted:#a4aa9d;--line:#3a3d35;--accent:#f08a62}} *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px ui-sans-serif,system-ui,sans-serif}main{display:grid;grid-template-columns:310px 1fr;min-height:100vh}aside{border-right:1px solid var(--line);padding:24px 16px;overflow:auto}h1{font:700 28px Georgia,serif;margin:0 0 24px}h2{font:700 24px Georgia,serif;margin:0 0 8px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:25px 0 8px}.task{display:block;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:7px;color:inherit;padding:12px;margin:4px 0;cursor:pointer}.task:hover,.task.active{background:var(--panel);border-color:var(--line)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#999;margin-right:8px}.running{background:#37a66a}.warning{background:#d5a528}.handoff{background:#4e91d8}.review{background:#9a65ce}.failed,.blocked{background:#d5534b}.agent{color:var(--muted);font-size:12px;margin:5px 0 0 18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.objective{margin-left:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}section{padding:42px clamp(24px,6vw,90px);max-width:1100px}.top{display:flex;justify-content:space-between;gap:16px;align-items:start}button,.send{border:1px solid var(--line);background:var(--panel);color:inherit;border-radius:5px;padding:9px 13px;cursor:pointer}button:hover{border-color:var(--accent)}pre{background:var(--panel);border:1px solid var(--line);padding:14px;overflow:auto;white-space:pre-wrap;max-height:360px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:18px}.box{border-top:2px solid var(--line);padding-top:10px}.box ul{padding-left:20px;line-height:1.55}.muted{color:var(--muted)}textarea{width:100%;min-height:70px;background:var(--panel);border:1px solid var(--line);color:inherit;padding:10px;margin:8px 0}.actions{display:flex;gap:8px;align-items:center}@media(max-width:700px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line);max-height:38vh}section{padding:28px 18px}}
</style></head><body><main><aside><h1>AgentBrain</h1><div id="tasks"></div></aside><section id="detail"><p class="muted">Select a task</p></section></main>
<script>
const token=location.hash.replace(/^#token=/,'');let state;let selected;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=(path,opts={})=>fetch(path,{...opts,headers:{'x-agentbrain-token':token,'content-type':'application/json',...(opts.headers||{})}}).then(r=>r.json());
const list=a=>a?.length?'<ul>'+a.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':'<p class="muted">None</p>';
function render(){if(!state)return;document.querySelector('#tasks').innerHTML=state.tasks.map(t=>'<button class="task '+(t.id===selected?'active':'')+'" data-id="'+esc(t.id)+'"><span class="dot '+(t.warning?'warning':esc(t.status))+'"></span>'+esc(t.id)+'<div class="agent">'+esc(t.agent||'unassigned')+'</div><div class="objective">'+esc(t.objective)+'</div></button>').join('')+(state.queue?.length?'<h3>Queue</h3>'+state.queue.map(q=>'<div class="objective muted">'+esc(q.objective)+'</div>').join(''):'');document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{selected=b.dataset.id;render();show()});show()}
async function show(){const t=state?.tasks.find(x=>x.id===selected)||state?.tasks[0];if(!t)return;selected=t.id;const prevMsg=document.querySelector('#message');const draft=prevMsg?prevMsg.value:'';const typing=document.activeElement===prevMsg;const prevPre=document.querySelector('#transcript');const pinned=!prevPre||prevPre.scrollTop+prevPre.clientHeight>=prevPre.scrollHeight-8;const [d,l]=await Promise.all([api('/api/diff?task='+encodeURIComponent(t.id)),api('/api/log?task='+encodeURIComponent(t.id))]);let live=t.liveSession;let transcript=live?await api('/api/transcript?session='+encodeURIComponent(live.sessionId)):null;document.querySelector('#detail').innerHTML='<div class="top"><div><p class="muted">'+esc(t.status)+(t.warning?' · '+esc(t.warning):'')+'</p><h2>'+esc(t.objective)+'</h2><p class="muted">'+esc(t.nextAction||'No next action recorded')+'</p></div><div class="actions"><button id="open">Open in VS Code</button>'+(live&&live.alive?'<button id="stop">Stop</button>':'')+'</div></div><div class="grid"><div class="box"><h3>Completed</h3>'+list(t.completed)+'</div><div class="box"><h3>Remaining</h3>'+list(t.remaining)+'</div><div class="box"><h3>Decisions</h3>'+list(t.decisions)+'</div><div class="box"><h3>Failures</h3>'+list(t.failures)+'</div></div><h3>Changed files and diff</h3><pre>'+esc(d.diff)+'</pre><h3>Timeline</h3><pre>'+esc(l.map(x=>x.timestamp+'  '+x.event+'  '+x.agent+'  '+x.reason).join('\\n'))+'</pre>'+(live&&live.mode==='headless'?'<h3>Live transcript</h3><pre id="transcript">'+esc((transcript?.transcript||[]).join('\\n'))+'</pre><textarea id="message" placeholder="Message this session"></textarea><button id="send">Send</button>':'')+'<p class="muted">Workdir: '+esc(t.workdir)+'</p>';const msg=document.querySelector('#message');if(msg){msg.value=draft;if(typing)msg.focus()}const pre=document.querySelector('#transcript');if(pre&&pinned)pre.scrollTop=pre.scrollHeight;document.querySelector('#open').onclick=()=>api('/api/open',{method:'POST',body:JSON.stringify({taskId:t.id})});document.querySelector('#stop')?.addEventListener('click',()=>api('/api/stop',{method:'POST',body:JSON.stringify({sessionId:live.sessionId})}));document.querySelector('#send')?.addEventListener('click',()=>{const m=document.querySelector('#message');api('/api/message',{method:'POST',body:JSON.stringify({sessionId:live.sessionId,text:m.value})});m.value=''})}
api('/api/snapshot').then(x=>{state=x;selected=x.tasks[0]?.id;render()});const events=new EventSource('/api/events?token='+encodeURIComponent(token));events.addEventListener('snapshot',e=>{state=JSON.parse(e.data);render()});
</script></body></html>`;