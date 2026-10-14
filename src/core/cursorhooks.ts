import fs from "node:fs";
import path from "node:path";
import { handleAgentHook, type ClaudeHookPayload } from "./claudehooks.js";
import { thoughtFrom } from "./thoughts.js";

/**
 * Cursor's agent reports to AgentBrain through Cursor hooks (.cursor/hooks.json),
 * the way Claude Code does through its own: sessions, your prompts, every file
 * edit and shell command, and what it is thinking, live in Activity and the
 * terminal. Connecting Cursor installs them; nothing here can block Cursor (the
 * hook never answers "don't continue", and a broken AgentBrain exits quietly).
 */

export const CURSOR_HOOKS = path.join(".cursor", "hooks.json");
const EVENTS = ["sessionStart", "beforeSubmitPrompt", "afterAgentThought", "afterAgentResponse", "afterFileEdit", "afterShellExecution", "afterMCPExecution", "stop", "sessionEnd"] as const;
const ours = (entry: any) => / hook cursor\b/.test(String(entry?.command ?? ""));

export function installCursorHooks(root: string, command: string): { file: string; action: "created" | "updated" | "unchanged" } {
  const file = path.join(root, CURSOR_HOOKS);
  const existed = fs.existsSync(file);
  let config: any = {};
  if (existed) {
    try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`${file} isn't plain JSON; add AgentBrain's hook by hand: ${command} hook cursor`); }
  }
  const before = JSON.stringify(config);
  config.version ??= 1;
  config.hooks ??= {};
  for (const event of EVENTS) {
    const entries = (config.hooks[event] ?? []).filter((entry: any) => !ours(entry));
    entries.push({ command: `${command} 2>/dev/null || true` });
    config.hooks[event] = entries;
  }
  if (JSON.stringify(config) === before) return { file, action: "unchanged" };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { file, action: existed ? "updated" : "created" };
}

export function uninstallCursorHooks(root: string): boolean {
  const file = path.join(root, CURSOR_HOOKS);
  let config: any;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (!config.hooks) return false;
  let changed = false;
  for (const event of Object.keys(config.hooks)) {
    const kept = (config.hooks[event] ?? []).filter((entry: any) => !ours(entry));
    if (kept.length !== config.hooks[event].length) changed = true;
    if (kept.length) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (changed) fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return changed;
}

export function cursorHooksInstalled(root: string): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, CURSOR_HOOKS), "utf8"));
    return EVENTS.every((event) => (config.hooks?.[event] ?? []).some(ours));
  } catch {
    return false;
  }
}

export interface CursorHookPayload {
  hook_event_name?: string;
  conversation_id?: string;
  session_id?: string;
  workspace_roots?: string[];
  transcript_path?: string;
  prompt?: string;
  text?: string;
  file_path?: string;
  command?: string;
  cwd?: string;
  tool_name?: string;
  status?: string;
  reason?: string;
}

/** Cursor's events in the shape AgentBrain's hook handler takes. */
export function fromCursor(payload: CursorHookPayload): ClaudeHookPayload | null {
  const session = String(payload.conversation_id ?? payload.session_id ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!session) return null;
  const cwd = payload.cwd ?? payload.workspace_roots?.[0];
  const base = { session_id: `cursor-${session}`, ...(cwd ? { cwd } : {}) };
  switch (payload.hook_event_name) {
    case "sessionStart": return { ...base, hook_event_name: "SessionStart" };
    case "beforeSubmitPrompt": return { ...base, hook_event_name: "UserPromptSubmit", prompt: payload.prompt ?? "" };
    case "afterAgentThought":
    case "afterAgentResponse": {
      const thought = thoughtFrom([{ type: "text", text: payload.text ?? "" }]);
      return thought ? { ...base, hook_event_name: "Thought", thought } : null;
    }
    case "afterFileEdit": return payload.file_path ? { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: payload.file_path } } : null;
    case "afterShellExecution": return payload.command ? { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: payload.command } } : null;
    case "afterMCPExecution": return { ...base, hook_event_name: "PostToolUse", tool_name: `mcp__${payload.tool_name ?? "tool"}` };
    case "stop": return { ...base, hook_event_name: "Stop" };
    case "sessionEnd": return { ...base, hook_event_name: "SessionEnd", ...(payload.reason ? { reason: payload.reason } : {}) };
    default: return null;
  }
}

/** One Cursor hook call. Prints nothing: an empty answer lets Cursor carry on. */
export function handleCursorHook(payload: CursorHookPayload, fallbackCwd = process.cwd()): void {
  const translated = fromCursor(payload);
  if (translated) handleAgentHook(translated, fallbackCwd, "cursor", "Cursor");
}
