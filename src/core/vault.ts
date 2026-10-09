import fs from "node:fs";
import path from "node:path";
import { readActivity, type ActivityEvent } from "./activity.js";
import { reviewPolicy, readReputation } from "./review.js";
import { brainDir } from "./paths.js";
import { getProject, listSessions, listTasks } from "./store.js";
import { recordActivity } from "./activity.js";
import { compilePatterns, redact } from "./redact.js";
import type { AgentSessionState, TaskState } from "./state.js";

const GENERATED = "generated: agentbrain";
const PSEUDO_AGENTS = new Set(["agentbrain", "council"]);

function vaultDir(root: string): string {
  return path.join(brainDir(root), "vault");
}

function noteFrontmatter(status: string, tags: string[]): string {
  return ["---", GENERATED, `status: ${status}`, "tags:", ...tags.map((tag) => `  - ${tag}`), "---", ""].join("\n");
}

function bulletList(items: string[] | undefined): string {
  return items?.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function taskAgents(task: TaskState, activity: ActivityEvent[]): string[] {
  return [...new Set([
    ...(task.agent ? [task.agent.id] : []),
    ...(task.review?.worker ? [task.review.worker] : []),
    ...(task.review?.votes ?? []).map((vote) => vote.agent),
    ...activity.filter((event) => event.task === task.id).map((event) => event.agent),
  ])].filter((agent) => agent && !PSEUDO_AGENTS.has(agent)).sort();
}

function taskNote(task: TaskState, activity: ActivityEvent[]): string {
  const events = activity.filter((event) => event.task === task.id);
  const agents = taskAgents(task, activity);
  const reviews = [
    ...(task.review ? [task.review] : []),
    ...(task.reviews ?? []),
  ];
  const files = [...new Set(events.flatMap((event) => event.files ?? []))].sort();
  const reviewText = reviews.length
    ? reviews.map((review) => {
      const votes = review.votes?.length
        ? review.votes.map((vote) => `${vote.agent}: ${vote.verdict}${vote.notes ? ` (${vote.notes})` : ""}`).join(", ")
        : "no votes";
      const flags = review.flags?.length ? `; flags: ${review.flags.map((flag) => flag.text).join(" | ")}` : "";
      const verdict = "verdict" in review ? review.verdict : "pending";
      const reviewer = "reviewer" in review ? review.reviewer : review.worker;
      return `- ${verdict} by ${reviewer ?? "unknown"}: ${votes}${flags}`;
    }).join("\n")
    : "- None";

  return [
    noteFrontmatter(task.status, ["agentbrain", "task"]),
    `# ${task.objective.length > 90 ? `${task.objective.slice(0, 88)}…` : task.objective}`,
    "",
    `**Task:** ${task.id}`,
    `**Objective:** ${task.objective}`,
    `**Status:** ${task.status}`,
    task.updatedAt ? `**Updated:** ${task.updatedAt}` : "",
    "",
    "## Completed",
    bulletList(task.completed),
    "",
    "## Remaining",
    bulletList(task.remaining),
    "",
    "## Decisions",
    task.decisions.length ? task.decisions.map((d, i) => `- [[Decisions/${decisionName(task.id, i, d)}|${d.replace(/[[\]|]/g, "")}]]`).join("\n") : "- None",
    "",
    "## Failures",
    bulletList(task.failures),
    "",
    "## Reviews",
    reviewText,
    "",
    "## Files touched",
    files.length ? files.map((f) => `- [[Code/${codeName(f)}|${f}]]`).join("\n") : "- None",
    "",
    "## Agents",
    agents.length ? agents.map((agent) => `- [[Agents/${safeFilePart(agent)}]]`).join("\n") : "- None",
    "",
  ].filter((line) => line !== "").join("\n");
}

function agentNote(agent: string, tasks: TaskState[], sessions: AgentSessionState[], activity: ActivityEvent[], reputation: ReturnType<typeof readReputation>[string]): string {
  const worked = tasks.filter((task) => taskAgents(task, activity).includes(agent));
  const reviewed = tasks.filter((task) => [
    ...(task.review?.votes ?? []).map((vote) => vote.agent),
    ...(task.reviews ?? []).map((review) => review.reviewer),
  ].includes(agent));
  const agentActivity = activity.filter((event) => event.agent === agent);
  const last = agentActivity.at(-1)?.at ?? sessions.filter((session) => session.agentId === agent).at(-1)?.lastSeenAt;
  return [
    noteFrontmatter("agent", ["agentbrain", "agent"]),
    `# ${agent}`,
    "",
    last ? `**Last activity:** ${last}` : "**Last activity:** None",
    reputation ? `**Reputation:** ${reputation.score} (agreed ${reputation.agreed}, dissented ${reputation.dissented}, flagged ${reputation.flagged})` : "**Reputation:** 1",
    "",
    "## Tasks worked on",
    worked.length ? worked.map((task) => `- [[Tasks/${safeFilePart(task.id)}]] (${task.status})`).join("\n") : "- None",
    "",
    "## Tasks reviewed",
    reviewed.length ? reviewed.map((task) => `- [[Tasks/${safeFilePart(task.id)}]]`).join("\n") : "- None",
    "",
    "## Sessions",
    sessions.filter((session) => session.agentId === agent).length
      ? sessions.filter((session) => session.agentId === agent).map((session) => `- ${session.sessionId}: ${session.taskId}`).join("\n")
      : "- None",
    "",
  ].filter((line) => line !== "").join("\n");
}

function writeNote(file: string, content: string): void {
  const normalized = `${content.trimEnd()}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === normalized) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, normalized, "utf8");
}

function removeGeneratedNotes(dir: string, keep: Set<string>): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) removeGeneratedNotes(file, keep);
    else if (entry.isFile() && !keep.has(file) && fs.readFileSync(file, "utf8").split("\n", 4).includes(GENERATED)) fs.unlinkSync(file);
  }
}

export function writeVault(root: string): string {
  const dir = vaultDir(root);
  const tasks = listTasks(root);
  const sessions = listSessions(root);
  const activity = readActivity(root);
  const reputation = readReputation(root);
  const policy = reviewPolicy(root);
  const agents = [...new Set([
    ...policy.reviewers,
    ...tasks.flatMap((task) => taskAgents(task, activity)),
    ...sessions.map((session) => session.agentId),
    ...activity.map((event) => event.agent),
  ])].filter((agent) => agent && !PSEUDO_AGENTS.has(agent)).sort();

  fs.mkdirSync(dir, { recursive: true });
  const notes = new Map<string, string>();
  notes.set(path.join(dir, "Brain.md"), [
    noteFrontmatter("index", ["agentbrain", "index"]),
    "# AgentBrain",
    "",
    `**Review policy:** ${policy.mode}${policy.reviewers.length ? ` (${policy.reviewers.map((agent) => `[[Agents/${safeFilePart(agent)}]]`).join(", ")})` : ""}`,
    "",
    "## Tasks by status",
    ...[...new Set(tasks.map((task) => task.status))].sort().map((status) => `### ${status}\n${tasks.filter((task) => task.status === status).map((task) => `- [[Tasks/${safeFilePart(task.id)}]]: ${task.objective}`).join("\n") || "- None"}`),
    "",
    "## Agents",
    agents.length ? agents.map((agent) => `- [[Agents/${safeFilePart(agent)}]]`).join("\n") : "- None",
    "",
    "## Rooms",
    "- [[Onboarding]]: read first",
    "- [[Lessons]]: what reviewers sent back, and claims that didn't hold",
    "- [[Decisions/index|Decisions]] · [[Code/index|Code map]] · [[Daily/index|Daily log]] · [[Memory/index|Memory]]",
    "",
  ].join("\n"));
  for (const task of tasks) notes.set(path.join(dir, "Tasks", `${safeFilePart(task.id)}.md`), taskNote(task, activity));
  for (const agent of agents) notes.set(path.join(dir, "Agents", `${safeFilePart(agent)}.md`), agentNote(agent, tasks, sessions, activity, reputation[agent]));
  // The memory palace: rooms every agent (new or returning) can walk through.
  for (const [name, content] of palaceRooms(root, tasks, activity, agents)) notes.set(path.join(dir, name), content);
  removeGeneratedNotes(dir, new Set(notes.keys()));
  for (const [file, content] of notes) writeNote(file, content);
  writeObsidianConfig(dir);
  return dir;
}

/* ---------------------------------------------------------------- the memory palace */

function slug(text: string, max = 60): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "note";
}

function decisionName(taskId: string, index: number, text: string): string {
  return `${slug(text, 50)}-${taskId.replace(/^task-/, "").slice(-6)}${index}`;
}

function codeName(file: string): string {
  return file.replace(/[\\/]/g, "__").replace(/[^A-Za-z0-9._-]/g, "-");
}

const link = (folder: string, name: string, label?: string) => `[[${folder}/${name}${label ? `|${label.replace(/[[\]|]/g, "")}` : ""}]]`;

/** Generated notes beyond tasks and agents: onboarding, lessons, decisions, code map, daily log. */
function palaceRooms(root: string, tasks: TaskState[], activity: ActivityEvent[], agents: string[]): [string, string][] {
  const rooms: [string, string][] = [];
  const policy = reviewPolicy(root);
  const project = getProject(root);

  // Lessons: everything the project learned the hard way.
  const sentBack = tasks.flatMap((t) => (t.reviews ?? []).filter((r) => r.verdict === "changes" && r.notes).map((r) => ({ t, r })));
  const flags = tasks.flatMap((t) => [...(t.reviews ?? []).flatMap((r) => r.flags ?? []), ...(t.review?.flags ?? [])].map((f) => ({ t, f })));
  const failures = tasks.flatMap((t) => t.failures.map((f) => ({ t, f })));
  rooms.push(["Lessons.md", [
    noteFrontmatter("lessons", ["agentbrain", "lessons"]),
    "# Lessons",
    "",
    "What reviewers sent back, claims that didn't match the evidence, and known failures. Read before you start; don't repeat these.",
    "",
    "## Sent back by reviewers",
    sentBack.length ? sentBack.map(({ t, r }) => `- ${r.notes!.split("\n").join("; ")} (work by ${r.worker ? link("Agents", safeFilePart(r.worker), r.worker) : "unknown"} on ${link("Tasks", safeFilePart(t.id), t.objective.slice(0, 50))})`).join("\n") : "- None yet",
    "",
    "## Claims that didn't hold",
    flags.length ? flags.map(({ t, f }) => `- ${f.kind}: ${f.text} (${link("Agents", safeFilePart(f.agent), f.agent)}, ${link("Tasks", safeFilePart(t.id), t.id)})`).join("\n") : "- None yet",
    "",
    "## Known failures",
    failures.length ? failures.map(({ t, f }) => `- ${f} (${link("Tasks", safeFilePart(t.id), t.id)})`).join("\n") : "- None",
  ].join("\n")]);

  // Decisions: one note each, so the graph shows why the code is the way it is.
  const decisions = tasks.flatMap((t) => t.decisions.map((d, i) => ({ t, d, i })));
  for (const { t, d, i } of decisions) {
    const who = (activity.find((e) => e.kind === "decision" && e.task === t.id && e.text === d)?.agent) ?? t.agent?.id;
    rooms.push([`Decisions/${decisionName(t.id, i, d)}.md`, [
      noteFrontmatter("decision", ["agentbrain", "decision"]),
      `# ${d.length > 90 ? `${d.slice(0, 88)}…` : d}`,
      "",
      d,
      "",
      `- Task: ${link("Tasks", safeFilePart(t.id), t.objective)}`,
      who && !PSEUDO_AGENTS.has(who) ? `- Decided by: ${link("Agents", safeFilePart(who), who)}` : "",
    ].filter((l) => l !== "").join("\n")]);
  }
  rooms.push(["Decisions/index.md", [
    noteFrontmatter("index", ["agentbrain", "decision"]),
    "# Decisions",
    "",
    decisions.length ? decisions.slice().reverse().map(({ t, d, i }) => `- ${link("Decisions", decisionName(t.id, i, d), d.slice(0, 100))}`).join("\n") : "- None yet",
  ].join("\n")]);

  // Code map: which files the work touched, by which tasks and agents.
  const touched = new Map<string, { tasks: Set<string>; agents: Set<string>; count: number }>();
  for (const e of activity) {
    if ((e.kind !== "edit" && e.kind !== "commit") || !e.files) continue;
    for (const f of e.files) {
      const entry = touched.get(f) ?? { tasks: new Set(), agents: new Set(), count: 0 };
      entry.count++;
      if (e.task) entry.tasks.add(e.task);
      if (!PSEUDO_AGENTS.has(e.agent)) entry.agents.add(e.agent);
      touched.set(f, entry);
    }
  }
  const hot = [...touched.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 150);
  for (const [file, info] of hot) {
    rooms.push([`Code/${codeName(file)}.md`, [
      noteFrontmatter("code", ["agentbrain", "code"]),
      `# ${file}`,
      "",
      `Changed ${info.count} time(s).`,
      "",
      "## Tasks",
      [...info.tasks].map((t) => `- ${link("Tasks", safeFilePart(t), tasks.find((x) => x.id === t)?.objective ?? t)}`).join("\n") || "- None",
      "",
      "## Agents",
      [...info.agents].map((a) => `- ${link("Agents", safeFilePart(a), a)}`).join("\n") || "- None",
    ].join("\n")]);
  }
  rooms.push(["Code/index.md", [
    noteFrontmatter("index", ["agentbrain", "code"]),
    "# Code map",
    "",
    "Files the agents changed most, and by which tasks.",
    "",
    hot.length ? hot.map(([f, i]) => `- ${link("Code", codeName(f), f)} (${i.count})`).join("\n") : "- Nothing yet",
  ].join("\n")]);

  // Daily log.
  const days = new Map<string, ActivityEvent[]>();
  for (const e of activity) {
    if (!["handoff", "review", "decision", "commit", "message", "status"].includes(e.kind)) continue;
    const day = e.at.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  for (const [day, events] of days) {
    rooms.push([`Daily/${day}.md`, [
      noteFrontmatter("daily", ["agentbrain", "daily"]),
      `# ${day}`,
      "",
      ...events.map((e) => `- ${e.at.slice(11, 16)} ${PSEUDO_AGENTS.has(e.agent) || e.agent === "developer" ? e.agent : link("Agents", safeFilePart(e.agent), e.agent)} ${e.text.replace(/[[\]]/g, "")}${e.task ? ` (${link("Tasks", safeFilePart(e.task), e.task)})` : ""}`),
    ].join("\n")]);
  }
  rooms.push(["Daily/index.md", [
    noteFrontmatter("index", ["agentbrain", "daily"]),
    "# Daily log",
    "",
    [...days.keys()].sort().reverse().map((d) => `- ${link("Daily", d, d)}`).join("\n") || "- Nothing yet",
  ].join("\n")]);

  // Memory: notes agents (and you) chose to keep. They are never regenerated.
  const memory = listMemory(root);
  rooms.push(["Memory/index.md", [
    noteFrontmatter("index", ["agentbrain", "memory"]),
    "# Memory",
    "",
    "Things worth remembering beyond any one task, written by agents (agentbrain_remember) or by you. Add your own notes anywhere in this vault; AgentBrain never overwrites them, and agents search them with agentbrain_recall.",
    "",
    memory.length ? memory.map((m) => `- ${link("Memory", m.name, m.title)}${m.author ? ` (${m.author})` : ""}`).join("\n") : "- Nothing yet",
  ].join("\n")]);

  // Onboarding: the first note any agent reads, new or returning.
  const active = tasks.filter((t) => !["done"].includes(t.status));
  rooms.push(["Onboarding.md", [
    noteFrontmatter("onboarding", ["agentbrain", "onboarding"]),
    "# Onboarding",
    "",
    "Welcome. Several coding agents work on this project, at the same time and one after another. This vault is the shared memory; AgentBrain keeps it current.",
    "",
    "## How work happens here",
    "- Every task has its own Git worktree. Work only in yours.",
    "- Record progress after each step (agentbrain_update); record decisions with their reason.",
    `- Finished work goes to review: ${policy.mode === "lead" ? `the lead, ${link("Agents", safeFilePart(policy.reviewers[0]), policy.reviewers[0])}, approves it` : policy.mode === "council" ? `a council (${policy.reviewers.map((r) => link("Agents", safeFilePart(r), r)).join(", ")}) votes on it` : "the developer approves it"}.`,
    project.checks?.length ? `- AgentBrain runs these itself on every result, and failing ones block approval: ${project.checks.map((c) => `\`${c}\``).join(", ")}.` : "- No automatic checks are set.",
    "- Claims are checked against the evidence: don't say tests pass unless they do, and don't mention files that don't exist.",
    "- Coordinate with agentbrain_message; split big work with agentbrain_delegate; search this memory with agentbrain_recall; save what future agents should know with agentbrain_remember.",
    "",
    "## Before you start, read",
    `- [[Lessons]] (${sentBack.length} things reviewers sent back, ${flags.length} claims that didn't hold)`,
    `- [[Decisions/index|Decisions]] (${decisions.length})`,
    `- [[Memory/index|Memory]] (${memory.length} notes)`,
    "",
    "## Agents on this project",
    agents.length ? agents.map((a) => `- ${link("Agents", safeFilePart(a), a)}`).join("\n") : "- None yet",
    "",
    "## Work in progress",
    active.length ? active.map((t) => `- ${link("Tasks", safeFilePart(t.id), t.objective)} (${t.status}${t.agent ? `, ${t.agent.id}` : ""})`).join("\n") : "- Nothing in progress",
  ].join("\n")]);
  return rooms;
}

/** An Obsidian-ready folder: graph colours per room. Never overwrites your own Obsidian settings. */
function writeObsidianConfig(dir: string): void {
  const config = path.join(dir, ".obsidian");
  fs.mkdirSync(config, { recursive: true });
  const graph = path.join(config, "graph.json");
  if (!fs.existsSync(graph)) {
    const group = (query: string, rgb: number) => ({ query, color: { a: 1, rgb } });
    fs.writeFileSync(graph, `${JSON.stringify({
      colorGroups: [
        group("path:Agents", 0x7b4fc9),
        group("path:Tasks", 0x2e6bc6),
        group("path:Decisions", 0xe0b25a),
        group("path:Code", 0x6b6862),
        group("path:Memory", 0x2f7d4f),
        group("file:Lessons OR file:Onboarding", 0xc2412d),
      ],
      showTags: false,
      showAttachments: false,
    }, null, 2)}\n`);
  }
  const app = path.join(config, "app.json");
  if (!fs.existsSync(app)) fs.writeFileSync(app, `${JSON.stringify({ alwaysUpdateLinks: true, newFileFolderPath: "Memory", newFileLocation: "folder" }, null, 2)}\n`);
}

/* ---------------------------------------------------------------- remember and recall */

interface MemoryNote {
  name: string;
  title: string;
  author?: string;
}

function listMemory(root: string): MemoryNote[] {
  const dir = path.join(vaultDir(root), "Memory");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md").sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    return {
      name: f.replace(/\.md$/, ""),
      title: /^# (.+)$/m.exec(text)?.[1] ?? f.replace(/\.md$/, ""),
      ...(/^author: (.+)$/m.exec(text)?.[1] ? { author: /^author: (.+)$/m.exec(text)![1] } : {}),
    };
  });
}

/** Saves a lasting note in the vault's Memory room. Notes are never regenerated or deleted. */
export function remember(root: string, note: { title: string; text: string; author: string; tags?: string[] }): string {
  const title = note.title.trim();
  if (!title || !note.text.trim()) throw new Error("A memory needs a title and some text.");
  const text = redact(note.text.trim(), compilePatterns(getProject(root).redactPatterns));
  const dir = path.join(vaultDir(root), "Memory");
  fs.mkdirSync(dir, { recursive: true });
  let name = slug(title);
  for (let n = 2; fs.existsSync(path.join(dir, `${name}.md`)); n++) name = `${slug(title)}-${n}`;
  const tags = ["memory", ...(note.tags ?? [])].map((t) => slug(t, 30));
  fs.writeFileSync(path.join(dir, `${name}.md`), [
    "---",
    `author: ${note.author}`,
    `created: ${new Date().toISOString()}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
    "",
    `# ${title}`,
    "",
    text,
    "",
    `Written by ${link("Agents", safeFilePart(note.author), note.author)}.`,
    "",
  ].join("\n"), "utf8");
  recordActivity(root, { agent: note.author, kind: "decision", text: `Remembered: ${title}` });
  return `Memory/${name}.md`;
}

export interface RecallHit {
  note: string;
  score: number;
  excerpt: string;
}

/** Searches every note in the vault (generated, agents' and yours) for the query's words. */
export function recall(root: string, query: string, limit = 6): RecallHit[] {
  const dir = writeVault(root);
  const words = query.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const hits: RecallHit[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith(".md") || entry.name === "index.md") continue;
      const raw = fs.readFileSync(file, "utf8");
      const generated = raw.split("\n", 4).includes(GENERATED);
      // Search what a reader sees: no frontmatter, and links by their label, not their target.
      const text = raw.replace(/^---[\s\S]*?---\n/, "").replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1").replace(/\[\[([^\]]*)\]\]/g, (_m, t: string) => t.split("/").pop() ?? t);
      const lower = text.toLowerCase();
      // How many of the query's words a note has matters most; how often, a little (capped),
      // so a long log that repeats one word doesn't outrank the note that is about the question.
      const counts = words.map((w) => lower.split(w).length - 1);
      const matched = counts.filter((c) => c > 0).length;
      if (!matched) continue;
      let score = matched * 10 + counts.reduce((sum, c) => sum + Math.min(c, 3), 0);
      // Notes people chose to keep, and lessons, count for more than generated logs.
      const rel = path.relative(dir, file).split(path.sep).join("/");
      if (rel.startsWith("Memory/") || !generated) score *= 2;
      if (rel === "Lessons.md" || rel.startsWith("Decisions/")) score *= 1.5;
      if (rel.startsWith("Daily/")) score *= 0.5;
      const lines = text.split("\n").filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 4);
      hits.push({ note: rel.replace(/\.md$/, ""), score, excerpt: lines.join("\n").slice(0, 600) });
    }
  };
  walk(dir);
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** A few lines of the hardest-won lessons, for an agent's first context. */
export function lessonsDigest(root: string, max = 6): string {
  const tasks = listTasks(root);
  const sentBack = tasks.flatMap((t) => (t.reviews ?? []).filter((r) => r.verdict === "changes" && r.notes).map((r) => r.notes!.split("\n")[0]));
  const memory = listMemory(root).map((m) => m.title);
  const lines = [...sentBack.slice(-max).map((n) => `- Reviewers sent back: ${n}`), ...memory.slice(-max).map((m) => `- Remembered: ${m}`)];
  return lines.length ? `Project memory (search more with agentbrain_recall; the vault is .agentbrain/vault, start at Onboarding):\n${lines.join("\n")}` : "";
}


/* ---------------------------------------------------------------- the vault as a graph */

export interface VaultNode {
  /** Path inside the vault without .md, e.g. "Tasks/task-1". */
  id: string;
  /** Top-level folder ("Tasks", "Agents", …) or "Home" for root notes. */
  room: string;
  title: string;
  links: string[];
  /** Written by an agent or the developer, not generated. */
  kept: boolean;
}

/**
 * The real vault read back from disk: every note and every [[link]] between
 * notes, exactly what Obsidian's graph view shows.
 */
export function vaultGraph(root: string): { dir: string; nodes: VaultNode[] } {
  const dir = writeVault(root);
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".md")) files.push(file);
    }
  };
  walk(dir);
  const ids = new Set(files.map((f) => path.relative(dir, f).split(path.sep).join("/").replace(/\.md$/, "")));
  const byBase = new Map<string, string>();
  for (const id of ids) byBase.set(id.split("/").pop()!.toLowerCase(), id);
  const nodes = files.map((file) => {
    const id = path.relative(dir, file).split(path.sep).join("/").replace(/\.md$/, "");
    const text = fs.readFileSync(file, "utf8");
    const links = new Set<string>();
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      const target = m[1].trim();
      // Obsidian resolves a link by full path, or by note name anywhere in the vault.
      const resolved = ids.has(target) ? target : byBase.get(target.split("/").pop()!.toLowerCase());
      if (resolved && resolved !== id) links.add(resolved);
    }
    return {
      id,
      room: id.includes("/") ? id.split("/")[0] : "Home",
      title: /^# (.+)$/m.exec(text)?.[1]?.trim() ?? id.split("/").pop()!,
      links: [...links],
      kept: !text.split("\n", 4).includes(GENERATED),
    };
  });
  return { dir, nodes };
}

/** One note's Markdown, by its vault id (never outside the vault). */
export function readNote(root: string, id: string): string {
  const dir = vaultDir(root);
  const file = path.resolve(dir, `${id}.md`);
  if (!file.startsWith(dir + path.sep)) throw new Error("Not a note in this vault.");
  if (!fs.existsSync(file)) throw new Error(`No note ${id}.`);
  return fs.readFileSync(file, "utf8");
}
