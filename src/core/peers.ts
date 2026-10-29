import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readActivity, type ActivityEvent } from "./activity.js";
import { listWorkers } from "./delegate.js";
import { brainDir } from "./paths.js";
import { compilePatterns, redact } from "./redact.js";
import { getProject, listTasks, readJson, writeJson } from "./store.js";
import { readNote, vaultGraph } from "./vault.js";

/**
 * Several machines, one picture. A control room started with `--share` is the hub; other
 * machines join it as peers and exchange tasks, activity and notes through it. Only that
 * summary moves: code travels through Git, never through the hub.
 */
export interface Peer { name: string; tokenHash: string; createdAt: string; lastSeen?: string }

export interface MachineTask { id: string; objective: string; status: string; agent?: string; updatedAt?: string; nextAction?: string }
export interface MachineNote { id: string; title: string; markdown: string }
/** Work one machine asks another to do (`machine:agent`), and what came back: a branch pushed to the shared Git remote. */
export interface RemoteJob { id: string; from: string; to: string; agent: string; objective: string; base: string; at: string }
export interface RemoteResult { job: string; machine: string; state: "ready" | "failed"; note: string; at: string }
export interface MachineData { machine: string; at: string; tasks: MachineTask[]; activity: ActivityEvent[]; notes: MachineNote[]; jobs: RemoteJob[]; results: RemoteResult[]; workers: Array<{ id: string; name: string }> }

/** This machine's side of remote work, kept in jobs.json. */
export interface JobBook {
  /** Whether other machines may start agents here. Off until the developer says so. */
  accept: boolean;
  out: Array<RemoteJob & { task: string; applied?: boolean }>;
  /** Jobs taken on here: job id → local task. */
  taken: Record<string, string>;
  results: RemoteResult[];
}
const jobsFile = (root: string) => path.join(brainDir(root), "jobs.json");
export function readJobs(root: string): JobBook {
  try { return { accept: false, out: [], taken: {}, results: [], ...readJson<Partial<JobBook>>(jobsFile(root)) }; } catch { return { accept: false, out: [], taken: {}, results: [] }; }
}
export function writeJobs(root: string, book: JobBook): void { writeJson(jobsFile(root), book); }

const peersFile = (root: string) => path.join(brainDir(root), "peers.json");
const hubFile = (root: string) => path.join(brainDir(root), "hub.json");
const remoteDir = (root: string) => path.join(brainDir(root), "remote");
const hash = (token: string) => createHash("sha256").update(token).digest();

export function machineName(): string {
  const name = process.env.AGENTBRAIN_MACHINE || os.hostname();
  return name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.]+/, "").slice(0, 40) || "machine";
}

function safeName(name: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,39}$/.test(name)) throw new Error(`Invalid machine name "${name}". Use letters, digits, ".", "_" or "-" (40 characters at most).`);
  return name;
}

export function listPeers(root: string): Peer[] {
  try { return readJson<Peer[]>(peersFile(root)); } catch { return []; }
}

/** Creates a peer and returns its token, which is shown once and stored only as a hash. */
export function addPeer(root: string, name: string): { peer: Peer; token: string } {
  safeName(name);
  const peers = listPeers(root);
  if (peers.some((p) => p.name === name) || name === machineName()) throw new Error(`A machine called "${name}" already exists.`);
  const token = randomBytes(24).toString("hex");
  const peer = { name, tokenHash: hash(token).toString("hex"), createdAt: new Date().toISOString() };
  writeJson(peersFile(root), [...peers, peer]);
  fs.chmodSync(peersFile(root), 0o600);
  return { peer, token };
}

export function revokePeer(root: string, name: string): boolean {
  const peers = listPeers(root);
  if (!peers.some((p) => p.name === name)) return false;
  writeJson(peersFile(root), peers.filter((p) => p.name !== name));
  fs.rmSync(path.join(remoteDir(root), `${safeName(name)}.json`), { force: true });
  return true;
}

export function peerForToken(root: string, token: string | undefined): Peer | undefined {
  if (!token) return undefined;
  const given = hash(token);
  return listPeers(root).find((p) => {
    const stored = Buffer.from(p.tokenHash, "hex");
    return stored.length === given.length && timingSafeEqual(given, stored);
  });
}

/** What this machine tells the others: no code, no diffs. */
export function localMachineData(root: string): MachineData {
  const extra = compilePatterns(getProject(root).redactPatterns);
  const r = (s: string) => redact(s, extra);
  const notes = vaultGraph(root).nodes.filter((n) => n.kept).slice(0, 50).flatMap((n) => {
    try { return [{ id: n.id, title: r(n.title), markdown: r(readNote(root, n.id).slice(0, 8000)) }]; } catch { return []; }
  });
  const tasks = listTasks(root).map((t) => ({ id: t.id, objective: r(t.objective), status: t.status, agent: t.agent?.id, updatedAt: t.updatedAt, nextAction: t.nextAction === undefined ? undefined : r(t.nextAction) }));
  const activity = readActivity(root, 100).map((e) => ({ ...e, text: r(e.text) }));
  const book = readJobs(root);
  const jobs = book.out.filter((j) => !j.applied).map(({ task: _task, applied: _applied, ...j }) => ({ ...j, objective: r(j.objective) }));
  return { machine: machineName(), at: new Date().toISOString(), tasks, activity, notes, jobs, results: book.results.map((x) => ({ ...x, note: r(x.note) })), workers: listWorkers(root).filter((w) => w.available && !w.id.includes(".")).map((w) => ({ id: w.id, name: w.name })) };
}

/** Clamps whatever a peer sent, and puts its own name on it. */
function clean(machine: string, data: Partial<MachineData>): MachineData {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const list = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
  return {
    machine,
    at: new Date().toISOString(),
    tasks: list<MachineTask>(data.tasks, 500).map((t) => ({ id: text(t?.id, 100), objective: text(t?.objective, 2000), status: text(t?.status, 30), agent: text(t?.agent, 100) || undefined, updatedAt: text(t?.updatedAt, 40) || undefined, nextAction: text(t?.nextAction, 500) || undefined })),
    activity: list<ActivityEvent>(data.activity, 200).map((e) => ({ at: text(e?.at, 40), agent: text(e?.agent, 100), kind: e?.kind, text: text(e?.text, 500), ...(e?.task ? { task: text(e.task, 100) } : {}) })),
    notes: list<MachineNote>(data.notes, 50).map((n) => ({ id: text(n?.id, 200), title: text(n?.title, 200), markdown: text(n?.markdown, 8000) })),
    // Ids end up in Git ref names and "from" is always the sender: nothing here is taken on trust.
    jobs: list<RemoteJob>(data.jobs, 50).filter((j) => /^[A-Za-z0-9_-]{1,40}$/.test(String(j?.id)) && /^[0-9a-f]{40}$/.test(String(j?.base))).map((j) => ({ id: j.id, from: machine, to: text(j.to, 40), agent: text(j.agent, 100), objective: text(j.objective, 2000), base: j.base, at: text(j.at, 40) })),
    workers: list<{ id: string; name: string }>(data.workers, 30).map((w) => ({ id: text(w?.id, 60), name: text(w?.name, 80) })).filter((w) => /^[A-Za-z0-9_.-]+$/.test(w.id) && w.name),
    results: list<RemoteResult>(data.results, 200).filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(String(x?.job))).map((x) => ({ job: x.job, machine, state: x.state === "ready" ? "ready" : "failed", note: text(x.note, 500), at: text(x.at, 40) })),
  };
}

function storeMachines(root: string, machines: MachineData[], keepOnly: boolean): void {
  fs.mkdirSync(remoteDir(root), { recursive: true });
  for (const m of machines) writeJson(path.join(remoteDir(root), `${safeName(m.machine)}.json`), m);
  if (keepOnly) for (const f of fs.readdirSync(remoteDir(root))) if (!machines.some((m) => `${m.machine}.json` === f)) fs.rmSync(path.join(remoteDir(root), f), { force: true });
}

export function remoteMachines(root: string): MachineData[] {
  try {
    return fs.readdirSync(remoteDir(root)).filter((f) => f.endsWith(".json")).map((f) => readJson<MachineData>(path.join(remoteDir(root), f)));
  } catch { return []; }
}

/** Hub side: takes a peer's push, answers with this machine and every other peer. */
export function hubExchange(root: string, peer: Peer, pushed: Partial<MachineData>): { you: string; machine: string; machines: MachineData[] } {
  storeMachines(root, [clean(peer.name, pushed)], false);
  writeJson(peersFile(root), listPeers(root).map((p) => (p.name === peer.name ? { ...p, lastSeen: new Date().toISOString() } : p)));
  return { you: peer.name, machine: machineName(), machines: [localMachineData(root), ...remoteMachines(root).filter((m) => m.machine !== peer.name)] };
}

export interface HubLink { url: string; token: string }

export function hubLink(root: string): HubLink | undefined {
  try { return readJson<HubLink>(hubFile(root)); } catch { return undefined; }
}

export function joinHub(root: string, url: string, token: string): HubLink {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("The hub address must start with http:// or https://");
  if (!/^[0-9a-f]{48}$/.test(token)) throw new Error("That is not a peer token; ask the hub for one with `agentbrain peers add <name>`.");
  const link = { url: parsed.origin, token };
  writeJson(hubFile(root), link);
  fs.chmodSync(hubFile(root), 0o600);
  return link;
}

export function leaveHub(root: string): boolean {
  const had = fs.existsSync(hubFile(root));
  fs.rmSync(hubFile(root), { force: true });
  fs.rmSync(remoteDir(root), { recursive: true, force: true });
  return had;
}

/** Peer side: pushes this machine's summary and stores everyone else's. Returns the machines pulled. */
export async function syncWithHub(root: string): Promise<number> {
  const link = hubLink(root);
  if (!link) throw new Error("Not joined to a hub; run agentbrain join <url> --token <peer-token>.");
  const response = await fetch(`${link.url}/api/peer/sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentbrain-peer": link.token },
    body: JSON.stringify(localMachineData(root)),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 403) throw new Error("The hub rejected this machine's token (revoked?).");
  if (!response.ok) throw new Error(`The hub answered ${response.status}.`);
  const { you, machines } = (await response.json()) as { you: string; machine: string; machines: MachineData[] };
  const others = (Array.isArray(machines) ? machines : []).filter((m) => typeof m?.machine === "string" && m.machine !== you).map((m) => clean(safeName(m.machine), m));
  storeMachines(root, others, true);
  return others.length;
}
