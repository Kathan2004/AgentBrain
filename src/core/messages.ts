import fs from "node:fs";
import path from "node:path";
import { recordActivity } from "./activity.js";
import { brainDir } from "./paths.js";
import { compilePatterns, redact } from "./redact.js";
import { getProject, readJson, writeJson } from "./store.js";

/**
 * The shared channel: agents (and the developer) working on the same project
 * at the same time can talk to each other. "Your uncommitted README blocks my
 * merge", "I'm changing the API, hold off on the client", "can you review
 * this?". Messages live in `.agentbrain/messages.jsonl`; each agent has a read
 * cursor, and unread messages reach it through its MCP tools, its hooks, or
 * (for the VS Code chat) a new chat message.
 */
export interface Message {
  id: string;
  at: string;
  from: string;
  /** An agent id, or "all". */
  to: string;
  task?: string;
  text: string;
}

function messagesFile(root: string): string {
  return path.join(brainDir(root), "messages.jsonl");
}

function cursorFile(root: string, agentId: string): string {
  return path.join(brainDir(root), "agents", agentId.replace(/[^A-Za-z0-9._-]/g, "-"), "inbox.json");
}

export function readMessages(root: string, limit = 200): Message[] {
  const file = messagesFile(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line) as Message];
    } catch {
      return [];
    }
  });
}

export function sendMessage(root: string, message: { from: string; to: string; text: string; task?: string }): Message {
  const text = redact(message.text.trim(), compilePatterns(getProject(root).redactPatterns)).slice(0, 4000);
  if (!text) throw new Error("The message is empty.");
  const to = message.to.trim().toLowerCase() || "all";
  const full: Message = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    from: message.from,
    to,
    ...(message.task ? { task: message.task } : {}),
    text,
  };
  fs.mkdirSync(brainDir(root), { recursive: true });
  fs.appendFileSync(messagesFile(root), `${JSON.stringify(full)}\n`, "utf8");
  recordActivity(root, { agent: message.from, kind: "message", text: `to ${to === "all" ? "everyone" : to}: ${text}`, ...(message.task ? { task: message.task } : {}) });
  return full;
}

/** Messages for `agentId` it hasn't seen yet (its own are never "unread"). */
export function unreadFor(root: string, agentId: string): Message[] {
  const file = cursorFile(root, agentId);
  const since = fs.existsSync(file) ? readJson<{ readUntil: string }>(file).readUntil : "";
  return readMessages(root, 500).filter((m) => m.at > since && m.from !== agentId && (m.to === agentId || m.to === "all"));
}

export function markRead(root: string, agentId: string, upTo: string = new Date().toISOString()): void {
  writeJson(cursorFile(root, agentId), { readUntil: upTo });
}

/** Unread messages as text for an agent's context, and marks them read. */
export function takeUnread(root: string, agentId: string): string {
  const unread = unreadFor(root, agentId);
  if (!unread.length) return "";
  markRead(root, agentId, unread.at(-1)!.at);
  return "Messages for you through AgentBrain (other agents and the developer work on this project at the same time; " +
    "answer with agentbrain_message if a reply is useful):\n" +
    unread.map((m) => `- from ${m.from}${m.to === "all" ? " to everyone" : ""}${m.task ? ` about ${m.task}` : ""}: ${m.text}`).join("\n");
}
