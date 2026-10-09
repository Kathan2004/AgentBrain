import fs from "node:fs";
import path from "node:path";
import { recordActivity, type ActivityKind } from "./activity.js";
import { findRoot } from "./paths.js";
import { compilePatterns, redact } from "./redact.js";
import { takeUnread } from "./messages.js";
import { lessonsDigest } from "./vault.js";
import { awaitingVote, isReviewer } from "./review.js";
import { SCHEMA_VERSION, type AgentSessionState } from "./state.js";
import { getProject, getSession, getTask, listTasks, saveSession, saveTask } from "./store.js";
import { taskForDir } from "./worktree.js";

/**
 * Claude Code hooks: every prompt, tool call and turn end in a Claude Code
 * session streams into AgentBrain's activity feed, so the control room shows
 * what Claude is doing as it happens. When Claude reviews other agents' work (lead or council), the hooks
 * also hand it finished work to review.
 */

const AGENT = "claude-code";
const MARK = "agentbrain hook claude";
const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] as const;

export const CLAUDE_SETTINGS = path.join(".claude", "settings.local.json");

function hookCommand(command: string): string {
  // Never let a broken AgentBrain get in Claude's way.
  return `${command} 2>/dev/null || true`;
}

// Matches both `agentbrain hook claude` and `node /path/to/main.js hook claude`.
const ours = (entry: any) => Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => / hook claude\b/.test(String(h?.command ?? "")));

/** Adds AgentBrain's hooks to `.claude/settings.local.json` (personal, not committed), keeping everything else. */
export function installClaudeHooks(root: string, command = MARK): { file: string; action: "created" | "updated" | "unchanged" } {
  const file = path.join(root, CLAUDE_SETTINGS);
  const existed = fs.existsSync(file);
  const settings = existed ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const before = JSON.stringify(settings);
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const entries = (settings.hooks[event] ?? []).filter((entry: any) => !ours(entry));
    entries.push({
      ...(event === "PostToolUse" ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command: hookCommand(command), timeout: 10 }],
    });
    settings.hooks[event] = entries;
  }
  if (JSON.stringify(settings) === before) return { file, action: "unchanged" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { file, action: existed ? "updated" : "created" };
}

export function uninstallClaudeHooks(root: string): boolean {
  const file = path.join(root, CLAUDE_SETTINGS);
  if (!fs.existsSync(file)) return false;
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!settings.hooks) return false;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const kept = (settings.hooks[event] ?? []).filter((entry: any) => !ours(entry));
    if (kept.length !== settings.hooks[event].length) changed = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (changed) fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return changed;
}

export function claudeHooksInstalled(root: string): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, CLAUDE_SETTINGS), "utf8"));
    return EVENTS.every((event) => (settings.hooks?.[event] ?? []).some(ours));
  } catch {
    return false;
  }
}

export interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  prompt?: string;
  source?: string;
  reason?: string;
  stop_hook_active?: boolean;
}

/** The real path, resolving the nearest folder that exists (the file may not exist yet). */
function realPath(file: string): string {
  let dir = file;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return file;
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

/** One line for the feed describing a tool call. */
export function describeTool(name: string, input: Record<string, any> = {}, root?: string): { kind: ActivityKind; text: string; files?: string[] } | null {
  const rel = (file: unknown) => {
    const f = String(file ?? "");
    if (!root || !path.isAbsolute(f)) return f;
    // Compare real paths: on macOS /var and /private/var are the same folder.
    // Forward slashes on every OS, so feeds, the vault and tests agree.
    const relative = path.relative(realPath(root), realPath(f)).split(path.sep).join("/");
    return relative && !relative.startsWith("..") ? relative : f.split(path.sep).join("/");
  };
  // AgentBrain's own tools already record what they do.
  if (name.startsWith("mcp__agentbrain__")) return null;
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const file = rel(input.file_path ?? input.notebook_path);
      return { kind: "edit", text: `${name === "Write" ? "Wrote" : "Edited"} ${file}`, files: [file] };
    }
    case "Bash":
      return { kind: "command", text: `$ ${String(input.command ?? "").split("\n")[0]}${input.description ? `  (${input.description})` : ""}` };
    case "Read":
      return { kind: "tool", text: `Read ${rel(input.file_path)}`, files: [rel(input.file_path)] };
    case "Grep":
    case "Glob":
      return { kind: "tool", text: `${name} ${String(input.pattern ?? "")}${input.path ? ` in ${rel(input.path)}` : ""}` };
    case "Task":
    case "Agent":
      return { kind: "tool", text: `Started a subagent: ${String(input.description ?? input.prompt ?? "").slice(0, 120)}` };
    case "WebFetch":
    case "WebSearch":
      return { kind: "tool", text: `${name} ${String(input.url ?? input.query ?? "")}` };
    case "TodoWrite":
      return null;
    default:
      return { kind: "tool", text: name.replace(/^mcp__/, "").replace(/__/g, ": ") };
  }
}

/** The task this Claude session is working on: its worktree's, the one it owns, else the active one. */
function sessionTask(root: string, cwd: string, session: AgentSessionState | null): string | undefined {
  const here = taskForDir(root, cwd);
  if (here) return here.id;
  if (session?.taskId) return session.taskId;
  const owned = listTasks(root).filter((t) => t.status === "running" && t.agent?.id === AGENT);
  if (owned.length === 1) return owned[0].id;
  return getProject(root).activeTaskId;
}

function reviewList(root: string): string {
  return awaitingVote(root, AGENT).map((t) => `- ${t.id} by ${t.review?.worker ?? t.agent?.id ?? "unknown"}: ${t.objective}`).join("\n");
}

/**
 * Handles one hook call. Returns what to print on stdout (JSON for Claude Code),
 * or "" for nothing. Never throws.
 */
export function handleClaudeHook(payload: ClaudeHookPayload, fallbackCwd = process.cwd()): string {
  try {
    const cwd = payload.cwd ?? fallbackCwd;
    const root = findRoot(cwd);
    if (!root || !payload.session_id || !/^[A-Za-z0-9._-]+$/.test(payload.session_id)) return "";
    const event = payload.hook_event_name ?? "";
    const sessionId = payload.session_id;
    const now = new Date().toISOString();
    const existing = getSession(root, AGENT, sessionId);
    const taskId = sessionTask(root, cwd, existing);
    const patterns = compilePatterns(getProject(root).redactPatterns);
    const note = (kind: ActivityKind, text: string, files?: string[]) =>
      recordActivity(root, { agent: AGENT, session: sessionId, ...(taskId ? { task: taskId } : {}), kind, text: redact(text, patterns), ...(files ? { files } : {}) });

    let lastAction = existing?.lastAction;
    let activity: AgentSessionState["activity"] = existing?.activity ?? "idle";
    let endedAt: string | undefined;
    let output = "";
    const isLead = isReviewer(root, AGENT);

    if (event === "SessionStart") {
      note("session", `Claude Code session ${payload.source === "resume" ? "resumed" : "started"}`);
      activity = "idle";
      if (isLead && awaitingVote(root, AGENT).length) {
        output = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext:
          `AgentBrain: you review other agents' work on this project. Results waiting for your review:\n${reviewList(root)}\nReview them with agentbrain_brief (task_id) and agentbrain_review.` } });
      }
    } else if (event === "UserPromptSubmit") {
      const text = String(payload.prompt ?? "").replace(/\s+/g, " ").trim();
      note("prompt", text.length > 200 ? `${text.slice(0, 200)}…` : text);
      activity = "working";
      lastAction = "Thinking about a new prompt";
      if (isLead && awaitingVote(root, AGENT).length) {
        output = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext:
          `AgentBrain: ${awaitingVote(root, AGENT).length} result(s) from other agents are waiting for your review (agentbrain_review). Handle the developer's request first unless it is about them.` } });
      }
    } else if (event === "PostToolUse") {
      const described = describeTool(payload.tool_name ?? "tool", payload.tool_input, root);
      if (described) {
        note(described.kind, described.text, described.files);
        lastAction = redact(described.text, patterns);
      }
      activity = "working";
    } else if (event === "Stop") {
      activity = "idle";
      lastAction = lastAction ? `Idle after: ${lastAction}` : "Idle";
      // The lead is about to go idle with results waiting: ask it to review them, once per result per session.
      if (isLead && !payload.stop_hook_active) {
        const fresh = awaitingVote(root, AGENT).filter((t) => !(t.review?.nudged ?? []).includes(sessionId));
        if (fresh.length) {
          for (const t of fresh) {
            const task = getTask(root, t.id);
            if (task.review) task.review.nudged = [...(task.review.nudged ?? []), sessionId];
            saveTask(root, task);
          }
          note("review", `Asked Claude Code to review ${fresh.map((t) => t.id).join(", ")}`);
          activity = "working";
          output = JSON.stringify({ decision: "block", reason:
            `AgentBrain: you review other agents' work here; check what they finished before stopping:\n` +
            fresh.map((t) => `- ${t.id} by ${t.review?.worker ?? t.agent?.id ?? "unknown"}: ${t.objective}`).join("\n") +
            "\nFor each: call agentbrain_brief with its task_id to see the summary and diff, check the changes, then " +
            "agentbrain_review with verdict approve, or changes plus concrete notes. Then tell the developer what you decided." });
        }
      }
    } else if (event === "SessionEnd") {
      note("session", `Claude Code session ended${payload.reason ? ` (${payload.reason})` : ""}`);
      endedAt = now;
    } else {
      return "";
    }

    // Messages from other agents (or the developer) reach Claude as soon as it does something,
    // and before it goes idle, so agents working in parallel can coordinate.
    if (event === "SessionStart" || event === "UserPromptSubmit" || event === "PostToolUse") {
      // A new session starts with the project's hardest-won lessons, like any other agent.
      const digest = event === "SessionStart" ? lessonsDigest(root) : "";
      const inbox = [digest, takeUnread(root, AGENT)].filter(Boolean).join("\n\n");
      if (inbox) {
        const previous = output ? JSON.parse(output).hookSpecificOutput?.additionalContext : "";
        output = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: [previous, inbox].filter(Boolean).join("\n\n") } });
      }
    } else if (event === "Stop" && !output && !payload.stop_hook_active) {
      const inbox = takeUnread(root, AGENT);
      if (inbox) {
        activity = "working";
        output = JSON.stringify({ decision: "block", reason: `${inbox}\nRespond to them (agentbrain_message, or act on them) before you stop.` });
      }
    }

    saveSession(root, {
      schemaVersion: SCHEMA_VERSION,
      agentId: AGENT,
      sessionId,
      taskId: taskId ?? existing?.taskId ?? "",
      taskIds: [...new Set([...(existing?.taskIds ?? []), ...(taskId ? [taskId] : [])])],
      startedAt: existing?.startedAt ?? now,
      ...(existing?.checkpointId ? { checkpointId: existing.checkpointId } : {}),
      ...(endedAt ? { endedAt } : {}),
      lastSeenAt: now,
      activity,
      ...(lastAction ? { lastAction } : {}),
    });
    return output;
  } catch {
    return "";
  }
}
