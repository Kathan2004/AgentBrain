import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createTask, updateTask } from "./actions.js";
import { recordActivity } from "./activity.js";
import { delegate } from "./delegate.js";
import { gitBinary } from "./platform.js";
import { machineName, readJobs, remoteMachines, writeJobs, type RemoteJob } from "./peers.js";
import { getTask, saveTask } from "./store.js";
import { addWorktree } from "./worktree.js";

/**
 * Work on another machine: `machine:agent` as a worker. The job travels with the peer sync, the
 * other machine works in its own checkout and pushes a branch to the shared Git remote, and this
 * machine fetches that branch into the task's worktree, ready to be reviewed like any other.
 */
const git = (cwd: string, args: string[]) => execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const branchFor = (job: Pick<RemoteJob, "from" | "id">) => `agentbrain/remote/${job.from}/${job.id}`;

export function delegateRemote(root: string, input: { worker: string; prompt?: string; taskId?: string; requestedBy?: string }) {
  const [machine, agent] = [input.worker.slice(0, input.worker.indexOf(":")), input.worker.slice(input.worker.indexOf(":") + 1)];
  const known = remoteMachines(root).map((m) => m.machine);
  if (!known.includes(machine)) throw new Error(`No machine called "${machine}" (${known.length ? `known: ${known.join(", ")}` : "none joined yet; see agentbrain join"}).`);
  if (!agent) throw new Error(`Name an agent too, as ${machine}:claude-code.`);
  try { git(root, ["remote", "get-url", "origin"]); } catch { throw new Error("Remote work travels through Git: this repository needs an origin remote both machines can reach."); }
  const base = git(root, ["rev-parse", "HEAD"]);
  if (!git(root, ["branch", "-r", "--contains", base])) throw new Error("The other machine can't see this commit yet: push your branch first.");

  const task = input.taskId ? getTask(root, input.taskId) : createTask(root, input.prompt ?? "");
  const objective = input.prompt && input.taskId ? input.prompt : task.objective;
  const job = { id: randomBytes(6).toString("hex"), from: machineName(), to: machine, agent, objective, base, at: new Date().toISOString() };
  const book = readJobs(root);
  writeJobs(root, { ...book, out: [...book.out, { ...job, task: task.id }] });
  const updated = updateTask(root, task.id, { status: "running", next: `Waiting for ${input.worker} to push its branch` });
  saveTask(root, { ...updated, delegatedTo: { worker: input.worker, at: job.at } });
  recordActivity(root, { agent: input.requestedBy ?? "developer", task: task.id, kind: "handoff", text: `Delegated to ${input.worker}: ${objective}` });
  return { task: getTask(root, task.id), job };
}

/** Machine side: starts the agents other machines asked for (only when this machine accepts them), and pushes finished branches. */
export function serveJobs(root: string, self: { command: string; args: string[] }): void {
  const book = readJobs(root);
  if (!book.accept) return;
  const me = machineName();
  for (const job of remoteMachines(root).flatMap((m) => m.jobs ?? [])) {
    if (job.to !== me || book.taken[job.id] || book.results.some((r) => r.job === job.id)) continue;
    const fail = (note: string) => book.results.push({ job: job.id, machine: me, state: "failed", note, at: new Date().toISOString() });
    try {
      try { git(root, ["fetch", "-q", "origin"]); } catch { /* offline: the commit may already be here */ }
      git(root, ["cat-file", "-e", `${job.base}^{commit}`]);
      const task = createTask(root, `From ${job.from}: ${job.objective}`, { activate: false });
      saveTask(root, { ...task, forMachine: job.from });
      addWorktree(root, task.id, job.base);
      book.taken[job.id] = task.id;
      writeJobs(root, book);
      delegate(root, { taskId: task.id, worker: job.agent, why: `asked by ${job.from}` }, self);
      recordActivity(root, { agent: "agentbrain", task: task.id, kind: "status", text: `Working for ${job.from}: ${job.objective}` });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [id, taskId] of Object.entries(book.taken)) {
    if (book.results.some((r) => r.job === id)) continue;
    const job = remoteMachines(root).flatMap((m) => m.jobs ?? []).find((j) => j.id === id);
    const task = getTask(root, taskId);
    if (!job || !task.worktree || !["review", "done", "failed"].includes(task.status)) continue;
    const at = new Date().toISOString();
    try {
      if (task.status === "failed" || git(task.worktree.path, ["rev-parse", "HEAD"]) === job.base) throw new Error(task.status === "failed" ? "The agent failed" : "The agent made no commits");
      git(root, ["push", "-q", "origin", `${task.worktree.branch}:refs/heads/${branchFor(job)}`]);
      book.results.push({ job: id, machine: me, state: "ready", note: "", at });
      updateTask(root, taskId, { status: "done", next: `Returned to ${job.from} as ${branchFor(job)}` });
    } catch (error) {
      book.results.push({ job: id, machine: me, state: "failed", note: error instanceof Error ? error.message : String(error), at });
    }
  }
  writeJobs(root, book);
}

const reported = new Map<string, string>();

/** Originating side: fetches the branches that came back into the tasks' worktrees and puts them up for review. */
export function collectResults(root: string): void {
  const book = readJobs(root);
  const results = remoteMachines(root).flatMap((m) => m.results ?? []);
  let changed = false;
  for (const job of book.out) {
    const result = job.applied ? undefined : results.find((r) => r.job === job.id && r.machine === job.to);
    if (!result) continue;
    try {
      if (result.state === "failed") {
        updateTask(root, job.task, { status: "failed", failures: [`${job.to}:${job.agent} could not finish: ${result.note}`] });
      } else {
        const task = addWorktree(root, job.task, job.base);
        git(task.worktree!.path, ["fetch", "-q", "origin", branchFor(job)]);
        git(task.worktree!.path, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
        updateTask(root, job.task, { status: "review", next: "Review the changes" });
        const t = getTask(root, job.task);
        saveTask(root, { ...t, review: { ...(t.review ?? { requestedAt: new Date().toISOString(), votes: [], checks: [], flags: [] }), worker: `${job.to}:${job.agent}` } });
        recordActivity(root, { agent: "agentbrain", task: job.task, kind: "status", text: `${job.to}:${job.agent} pushed its branch; ready for review` });
      }
      job.applied = true;
      changed = true;
    } catch (error) {
      if (reported.get(job.id) === String(error)) continue;
      reported.set(job.id, String(error));
      recordActivity(root, { agent: "agentbrain", task: job.task, kind: "status", text: `Fetching ${job.to}'s result failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (changed) writeJobs(root, book);
}
