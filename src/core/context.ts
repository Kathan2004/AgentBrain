import { readActivity, type ActivityEvent } from "./activity.js";
import { tierGuide } from "./models.js";
import { reviewPolicy } from "./review.js";
import { getProject, listTasks } from "./store.js";
import { recall } from "./vault.js";

/**
 * The shared context: one picture of the project that every agent gets, the
 * same way, whichever tool it is (MCP agent, background run, VS Code chat,
 * Claude Code hooks). Work quality shouldn't depend on which agent picked the
 * task up, so none of them should know less than the others.
 */

const PSEUDO = new Set(["agentbrain", "council", "developer"]);
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Who is working on what right now, and the files they are touching. */
export function liveTeam(root: string, me?: string, taskId?: string): string {
  const running = listTasks(root).filter((t) => t.status === "running" && t.id !== taskId);
  const since = Date.now() - 2 * 3_600_000;
  const touched = new Map<string, Set<string>>();
  for (const e of readActivity(root, 600)) {
    if (Date.parse(e.at) < since || !e.files || (e.kind !== "edit" && e.kind !== "commit") || e.agent === me || PSEUDO.has(e.agent)) continue;
    if (e.task && e.task === taskId) continue;
    const set = touched.get(e.agent) ?? new Set<string>();
    e.files.forEach((f) => set.add(f));
    touched.set(e.agent, set);
  }
  const lines = running.map((t) => `- ${t.agent?.id ?? "unassigned"} is working on ${t.id}: ${short(t.objective, 90)}${t.nextAction ? ` (next: ${short(t.nextAction, 70)})` : ""}`);
  for (const [agent, files] of touched) lines.push(`- ${agent} recently changed: ${[...files].slice(0, 8).join(", ")}${files.size > 8 ? ", …" : ""}`);
  return lines.length ? `## Working alongside you right now\n${lines.join("\n")}\nAvoid editing the same files; coordinate with agentbrain_message if you must.` : "";
}

/** How work is judged here, lessons, kept memory and recent decisions: the project's memory. */
export function projectMemory(root: string): string {
  const policy = reviewPolicy(root);
  const project = getProject(root);
  const tasks = listTasks(root);
  const sentBack = tasks.flatMap((t) => (t.reviews ?? []).filter((r) => r.verdict === "changes" && r.notes).map((r) => `- ${short(r.notes!.split("\n").join("; "), 200)}`)).slice(-8);
  const decisions = tasks
    .flatMap((t) => t.decisions.map((d) => ({ d, at: t.updatedAt ?? "", id: t.id })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8)
    .map((x) => `- ${short(x.d, 180)} (${x.id})`);
  const parts = [
    "## How work is judged here",
    `- ${policy.mode === "lead" ? `The lead, ${policy.reviewers[0]}, reviews every result.` : policy.mode === "council" ? `A council (${policy.reviewers.join(", ")}) votes on every result.` : "The developer reviews every result."}`,
    project.checks?.length ? `- AgentBrain runs these itself on your result; failing ones block approval: ${project.checks.join("; ")}.` : "",
    "- Claims are checked against the evidence: don't say tests pass unless you ran them; don't mention files that don't exist.",
  ];
  if (sentBack.length) parts.push("", "## Lessons: what reviewers sent back before (don't repeat these)", ...sentBack);
  if (decisions.length) parts.push("", "## Recent decisions on this project", ...decisions);
  return parts.filter((l) => l !== "").join("\n");
}

/** Notes from the vault that bear on this objective (lessons, decisions, kept memory). */
export function relevantMemory(root: string, objective: string, limit = 3): string {
  try {
    // Lessons and the index notes are already in the shared context; task notes and logs are noise here.
    const skip = (note: string) => /^(Tasks|Daily)\//.test(note) || /(^|\/)index$/.test(note) || ["Brain", "Lessons", "Onboarding"].includes(note);
    const hits = recall(root, objective, limit + 8).filter((h) => !skip(h.note)).slice(0, limit);
    if (!hits.length) return "";
    const text = `## From the project's memory, relevant to this task\n${hits.map((h) => `### ${h.note}\n${short(h.excerpt, 400)}`).join("\n")}\n(Search more with agentbrain_recall.)`;
    return short(text, 1500);
  } catch {
    return "";
  }
}

/** Everything an agent should know before working on `taskId`, the same for every agent. */
export function sharedContext(root: string, options: { taskId?: string; objective?: string; agentId?: string } = {}): string {
  // Tier workers (ids with a dot, e.g. claude-code.haiku) only execute; delegation is the platform/lead's job.
  const isLeadOrPlatform = !options.agentId || !options.agentId.includes(".");
  return [
    liveTeam(root, options.agentId, options.taskId),
    projectMemory(root),
    options.objective ? relevantMemory(root, options.objective) : "",
    isLeadOrPlatform ? tierGuide(root) : "",
  ].filter(Boolean).join("\n\n");
}

/** What other agents did since `since` that this agent should hear about mid-task. */
export function changesSince(root: string, since: string, me: string, taskId?: string, limit = 6): string {
  const notable = (e: ActivityEvent) =>
    // Same millisecond counts: the agent's own events are filtered out by name, not time.
    e.at >= since && e.agent !== me && (
      e.kind === "decision" ||
      (e.kind === "review" && !/^[✓✗]/.test(e.text)) ||
      (e.kind === "handoff" && e.task !== taskId) ||
      (e.kind === "commit" && e.agent !== "developer") ||
      (e.kind === "status" && /→ (done|review)/.test(e.text))
    );
  const events = readActivity(root, 400).filter(notable).slice(-limit);
  if (!events.length) return "";
  return `Since your last step, on this project:\n${events.map((e) => `- ${e.agent}${e.task && e.task !== taskId ? ` (${e.task})` : ""}: ${short(e.text, 160)}`).join("\n")}`;
}

/**
 * What a chat agent gets before the question: everything AgentBrain already
 * knows that a question about the project is likely to need (who is working on
 * what, the tasks, today's commits and events, the memory), so it answers from
 * the brain instead of exploring the repository again.
 */
export function chatBrief(root: string, question: string, commitsToday = ""): string {
  const tasks = listTasks(root);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = dayStart.toISOString();
  const open = tasks.filter((t) => t.status !== "done");
  const finished = tasks
    .filter((t) => t.status === "done" && (t.updatedAt ?? "") >= new Date(Date.now() - 24 * 3_600_000).toISOString())
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 12);
  // Open tasks are what people ask about, so they keep more of their objective.
  const line = (t: (typeof tasks)[number]) =>
    `- ${t.id} [${t.status}${t.agent ? `, ${t.agent}` : ""}] ${short(t.objective.split("\n")[0], t.status === "done" ? 140 : 400)}${t.nextAction ? ` (next: ${short(t.nextAction, 80)})` : ""}`;
  const events = readActivity(root, 1500)
    .filter((e) => e.at >= today && ["decision", "status", "commit", "review", "handoff"].includes(e.kind) && !/^[✓✗]/.test(e.text))
    .slice(-30);
  return [
    "AgentBrain's shared memory for this project, current as of now. Answer from it directly when it covers the question; read files or run commands only for what it doesn't cover.",
    liveTeam(root),
    `Open tasks (${open.length}):\n${open.map(line).join("\n") || "- none"}`,
    finished.length ? `Finished in the last 24 hours:\n${finished.map(line).join("\n")}` : "",
    commitsToday.trim() ? `Commits today (all branches):\n${commitsToday.trim()}` : "",
    events.length ? `Today's events:\n${events.map((e) => `- ${e.at.slice(11, 16)} ${e.agent}${e.task ? ` (${e.task})` : ""}: ${short(e.text, 150)}`).join("\n")}` : "",
    projectMemory(root),
    relevantMemory(root, question),
  ].filter(Boolean).join("\n\n");
}
