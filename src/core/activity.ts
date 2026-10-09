import fs from "node:fs";
import path from "node:path";
import { brainDir } from "./paths.js";

/**
 * The live feed of what agents are doing: one JSON object per line in
 * `.agentbrain/activity.jsonl`. Hooks, the MCP server, commits and status
 * changes append to it; the control room reads it. Callers redact free text.
 */
export type ActivityKind =
  | "session"
  | "prompt"
  | "tool"
  | "edit"
  | "command"
  | "commit"
  | "status"
  | "decision"
  | "progress"
  | "handoff"
  | "review"
  | "message";

export interface ActivityEvent {
  at: string;
  agent: string;
  session?: string;
  task?: string;
  kind: ActivityKind;
  text: string;
  files?: string[];
}

/** Past this size the oldest half of the file is dropped. */
const MAX_BYTES = 2_000_000;

export function activityFile(root: string): string {
  return path.join(brainDir(root), "activity.jsonl");
}

/** Appends an event. Never throws: activity is a side channel. */
export function recordActivity(root: string, event: Omit<ActivityEvent, "at"> & { at?: string }): void {
  try {
    const file = activityFile(root);
    const line = JSON.stringify({ at: event.at ?? new Date().toISOString(), ...event, text: event.text.slice(0, 500) });
    fs.appendFileSync(file, `${line}\n`, "utf8");
    if (fs.statSync(file).size > MAX_BYTES) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, "utf8");
      fs.renameSync(tmp, file);
    }
  } catch {
    // A missing or read-only .agentbrain must never break the caller.
  }
}

/** The newest `limit` events, oldest first. */
export function readActivity(root: string, limit = 200): ActivityEvent[] {
  const file = activityFile(root);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit);
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as ActivityEvent];
    } catch {
      return [];
    }
  });
}
