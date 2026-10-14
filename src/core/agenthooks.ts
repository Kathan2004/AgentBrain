import fs from "node:fs";
import path from "node:path";
import { handleAgentHook, type ClaudeHookPayload } from "./claudehooks.js";
import { CURSOR_HOOKS, cursorHooksInstalled, fromCursor, installCursorHooks, uninstallCursorHooks } from "./cursorhooks.js";
import { thoughtFrom } from "./thoughts.js";

/**
 * Live reporting for every connected agent that has hooks, not just Claude Code.
 * Each platform names its hook file, its events and its payloads differently; an
 * adapter here knows one platform's dialect: where its hooks live, how to add
 * AgentBrain's without touching the developer's own, and how to turn what the
 * platform sends into the events AgentBrain records (prompt, thought, edit,
 * command, session start/end). Connecting an agent installs its hooks, so its
 * edits show up live in Activity for everyone, the moment it makes them.
 *
 * Agents without hooks are covered another way: their MCP connection reports
 * their presence (mcp/server.ts), their transcripts are read where they keep
 * them on disk (transcripts.ts), and edits nobody reported are seen on disk
 * (diskedits.ts).
 */

export interface HookAdapter {
  /** `agentbrain hook <platform>` */
  platform: string;
  /** The agent the events are credited to. */
  agent: string;
  label: string;
  /** Connector ids whose connection installs these hooks. */
  connectors: string[];
  /** The hook config file, relative to the project. */
  file: string;
  install(root: string, command: string): { file: string; action: "created" | "updated" | "unchanged" };
  uninstall(root: string): boolean;
  installed(root: string): boolean;
  translate(payload: any, fallbackCwd: string): ClaudeHookPayload | null;
  /** What the hook prints back; empty lets the platform carry on. */
  reply?: string;
}

const quiet = (command: string) => `${command} 2>/dev/null || true`;
const mark = (platform: string) => new RegExp(` hook ${platform}\\b`);
const cleanId = (value: unknown) => String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "");

function readConfig(file: string): any {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error(`${file} isn't plain JSON (comments?); add AgentBrain's hooks by hand`); }
}

function writeIfChanged(file: string, config: any, before: string, existed: boolean) {
  if (JSON.stringify(config) === before) return { file, action: "unchanged" as const };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { file, action: existed ? "updated" as const : "created" as const };
}

/**
 * Hook files shaped `{ hooks: { event: [entry, …] } }`, one command per entry
 * (Windsurf, Copilot). `entry` builds AgentBrain's entry; `isOurs` finds it again.
 */
function flatFile(rel: string, platform: string, events: readonly string[], entry: (command: string) => Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const re = mark(platform);
  const isOurs = (e: any) => Object.values(e ?? {}).some((v) => typeof v === "string" && re.test(v));
  return {
    install(root: string, command: string) {
      const file = path.join(root, rel);
      const existed = fs.existsSync(file);
      const config = readConfig(file);
      const before = JSON.stringify(config);
      for (const [k, v] of Object.entries(extra)) config[k] ??= v;
      config.hooks ??= {};
      for (const event of events) config.hooks[event] = [...(config.hooks[event] ?? []).filter((e: any) => !isOurs(e)), entry(quiet(command))];
      return writeIfChanged(file, config, before, existed);
    },
    uninstall(root: string) {
      const file = path.join(root, rel);
      let config: any;
      try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
      let changed = false;
      for (const event of Object.keys(config.hooks ?? {})) {
        const kept = (config.hooks[event] ?? []).filter((e: any) => !isOurs(e));
        if (kept.length === config.hooks[event].length) continue;
        changed = true;
        if (kept.length) config.hooks[event] = kept;
        else delete config.hooks[event];
      }
      if (!changed) return false;
      // A file that only ever held AgentBrain's hooks goes away with them.
      const empty = !Object.keys(config.hooks).length && Object.keys(config).every((k) => k === "hooks" || k in extra);
      if (empty) fs.rmSync(file);
      else fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      return true;
    },
    installed(root: string) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
        return events.every((event) => (config.hooks?.[event] ?? []).some(isOurs));
      } catch {
        return false;
      }
    },
  };
}

/** Hook settings shaped like Claude Code's: `{ hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }` (Gemini CLI). */
function nestedFile(rel: string, platform: string, events: readonly string[]) {
  const re = mark(platform);
  const isOurs = (e: any) => Array.isArray(e?.hooks) && e.hooks.some((h: any) => re.test(String(h?.command ?? "")));
  return {
    install(root: string, command: string) {
      const file = path.join(root, rel);
      const existed = fs.existsSync(file);
      const config = readConfig(file);
      const before = JSON.stringify(config);
      config.hooks ??= {};
      for (const event of events) {
        config.hooks[event] = [...(config.hooks[event] ?? []).filter((e: any) => !isOurs(e)),
          { matcher: "*", hooks: [{ name: "agentbrain", type: "command", command: quiet(command), timeout: 10_000 }] }];
      }
      return writeIfChanged(file, config, before, existed);
    },
    uninstall(root: string) {
      const file = path.join(root, rel);
      let config: any;
      try { config = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
      let changed = false;
      for (const event of Object.keys(config.hooks ?? {})) {
        const kept = (config.hooks[event] ?? []).filter((e: any) => !isOurs(e));
        if (kept.length === config.hooks[event].length) continue;
        changed = true;
        if (kept.length) config.hooks[event] = kept;
        else delete config.hooks[event];
      }
      if (config.hooks && !Object.keys(config.hooks).length) delete config.hooks;
      if (changed) fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      return changed;
    },
    installed(root: string) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
        return events.every((event) => (config.hooks?.[event] ?? []).some(isOurs));
      } catch {
        return false;
      }
    },
  };
}

const said = (text: unknown) => thoughtFrom([{ type: "text", text: String(text ?? "") }]);

/** Tool names that write files, across platforms. */
const WRITES = /^(edit|write|replace|write_file|edit_file|create_file|str_replace|apply_patch|multiedit|notebookedit|insert)/i;
const SHELL = /^(bash|shell|run_shell_command|run_command|terminal|execute|exec|run_in_terminal)/i;

/** A tool call from any platform, in the form AgentBrain's handler reads. */
function toolCall(base: Record<string, unknown>, name: string, input: any): ClaudeHookPayload {
  const args = typeof input === "string" ? (() => { try { return JSON.parse(input); } catch { return { command: input }; } })() : input ?? {};
  const file = args.file_path ?? args.path ?? args.filePath ?? args.absolute_path ?? args.target_file;
  if (WRITES.test(name) && file) return { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: String(file) } };
  if (SHELL.test(name) && (args.command ?? args.cmd)) return { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: String(args.command ?? args.cmd) } };
  return { ...base, hook_event_name: "PostToolUse", tool_name: name, tool_input: args };
}

const GEMINI_EVENTS = ["SessionStart", "BeforeAgent", "AfterAgent", "AfterTool", "SessionEnd"] as const;
const WINDSURF_EVENTS = ["pre_user_prompt", "post_cascade_response", "post_write_code", "post_run_command", "post_mcp_tool_use"] as const;
const COPILOT_EVENTS = ["sessionStart", "userPromptSubmitted", "postToolUse", "sessionEnd"] as const;

export const HOOK_ADAPTERS: HookAdapter[] = [
  {
    platform: "cursor", agent: "cursor", label: "Cursor", connectors: ["cursor", "cursor-agent"], file: CURSOR_HOOKS,
    install: installCursorHooks, uninstall: uninstallCursorHooks, installed: cursorHooksInstalled,
    translate: (payload) => fromCursor(payload),
  },
  {
    // Gemini CLI hooks live next to its MCP servers, in .gemini/settings.json.
    platform: "gemini", agent: "gemini", label: "Gemini CLI", connectors: ["gemini", "gemini-assist"], file: path.join(".gemini", "settings.json"),
    ...nestedFile(path.join(".gemini", "settings.json"), "gemini", GEMINI_EVENTS),
    reply: "{}",
    translate(payload, fallbackCwd) {
      const session = cleanId(payload.session_id);
      if (!session) return null;
      const base = { session_id: `gemini-${session}`, cwd: payload.cwd ?? fallbackCwd, ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}) };
      switch (payload.hook_event_name) {
        case "SessionStart": return { ...base, hook_event_name: "SessionStart", ...(payload.source === "resume" ? { source: "resume" } : {}) };
        case "BeforeAgent": return { ...base, hook_event_name: "UserPromptSubmit", prompt: String(payload.prompt ?? "") };
        case "AfterAgent": {
          const thought = said(payload.prompt_response);
          return thought ? { ...base, hook_event_name: "Thought", thought } : { ...base, hook_event_name: "Stop" };
        }
        case "AfterTool": return toolCall(base, String(payload.tool_name ?? "tool"), payload.tool_input);
        case "SessionEnd": return { ...base, hook_event_name: "SessionEnd", ...(payload.reason ? { reason: payload.reason } : {}) };
        default: return null;
      }
    },
  },
  {
    // Windsurf's Cascade hooks (.windsurf/hooks.json): one trajectory per conversation.
    platform: "windsurf", agent: "windsurf", label: "Windsurf", connectors: ["windsurf"], file: path.join(".windsurf", "hooks.json"),
    ...flatFile(path.join(".windsurf", "hooks.json"), "windsurf", WINDSURF_EVENTS, (command) => ({ command, show_output: false })),
    translate(payload, fallbackCwd) {
      const session = cleanId(payload.trajectory_id ?? payload.execution_id);
      if (!session) return null;
      const info = payload.tool_info ?? {};
      const cwd = info.cwd ?? (info.file_path ? path.dirname(String(info.file_path)) : fallbackCwd);
      const base = { session_id: `windsurf-${session}`, cwd };
      switch (payload.agent_action_name) {
        case "pre_user_prompt": return { ...base, hook_event_name: "UserPromptSubmit", prompt: String(info.user_prompt ?? "") };
        case "post_cascade_response": {
          const thought = said(info.response);
          return thought ? { ...base, hook_event_name: "Thought", thought } : { ...base, hook_event_name: "Stop" };
        }
        case "post_write_code": return info.file_path ? { ...base, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: String(info.file_path) } } : null;
        case "post_run_command": return info.command_line ? { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: String(info.command_line) } } : null;
        case "post_mcp_tool_use": return { ...base, hook_event_name: "PostToolUse", tool_name: `mcp__${info.mcp_server_name ?? "server"}__${info.mcp_tool_name ?? "tool"}` };
        default: return null;
      }
    },
  },
  {
    // GitHub Copilot's agent hooks (.github/hooks/*.json), read by both Copilot CLI and
    // Copilot in VS Code. `bash` is the CLI's key, `command` VS Code's.
    platform: "copilot", agent: "copilot", label: "GitHub Copilot", connectors: ["copilot", "copilot-cli", "vscode"], file: path.join(".github", "hooks", "agentbrain.json"),
    ...flatFile(path.join(".github", "hooks", "agentbrain.json"), "copilot", COPILOT_EVENTS, (command) => ({ type: "command", bash: command, command, timeoutSec: 10 }), { version: 1 }),
    translate(payload, fallbackCwd) {
      const cwd = payload.cwd ?? fallbackCwd;
      // Copilot CLI sends no session id; one conversation per folder per day is close enough.
      const session = cleanId(payload.sessionId ?? payload.session_id) || `${cleanId(path.basename(cwd))}-${new Date().toISOString().slice(0, 10)}`;
      const base = { session_id: `copilot-${session}`, cwd, ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}) };
      const event = String(payload.hookEventName ?? payload.hook_event_name ?? payload.event ?? "");
      const name = payload.toolName ?? payload.tool_name;
      if (/^sessionstart$/i.test(event)) return { ...base, hook_event_name: "SessionStart" };
      if (/^sessionend$/i.test(event)) return { ...base, hook_event_name: "SessionEnd", ...(payload.reason ? { reason: String(payload.reason) } : {}) };
      if (/^(userpromptsubmitted|userpromptsubmit)$/i.test(event) || (!event && payload.prompt && !name)) return { ...base, hook_event_name: "UserPromptSubmit", prompt: String(payload.prompt ?? "") };
      if (/^posttooluse$/i.test(event) || (!event && name)) return name ? toolCall(base, String(name), payload.toolArgs ?? payload.tool_input) : null;
      if (/^stop$/i.test(event)) return { ...base, hook_event_name: "Stop" };
      return null;
    },
  },
];

/**
 * The command a platform runs for its hooks. Editors are GUI apps: on macOS they
 * may not have your shell's PATH, so a bare `agentbrain` (or even `node`) isn't
 * found and the hook silently does nothing. Use absolute paths to node and
 * AgentBrain's script.
 */
export function hookCommandFor(platform: string, command: string, args: string[] = []): string {
  const q = (x: string) => (/^[\w./@:+-]+$/.test(x) ? x : JSON.stringify(x));
  let script: string | null = null;
  if (command === "agentbrain") {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(dir, "agentbrain");
      try { if (fs.existsSync(candidate)) { script = fs.realpathSync(candidate); break; } } catch { /* keep looking */ }
    }
  }
  if (script && /\.(c|m)?js$/.test(script)) return `${q(process.execPath)} ${q(script)} hook ${platform}`;
  if (script) return `${q(script)} hook ${platform}`;
  return [command === process.execPath || command === "node" ? q(process.execPath) : q(command), ...args.map(q), "hook", platform].join(" ");
}

/**
 * A hook file AgentBrain created holds this machine's paths (node, AgentBrain), so
 * it belongs to this checkout, not the repository: list it in .git/info/exclude,
 * which is local and never committed.
 */
export function excludeLocally(root: string, rel: string): void {
  try {
    const info = path.join(root, ".git", "info");
    if (!fs.existsSync(path.join(root, ".git")) || !fs.statSync(path.join(root, ".git")).isDirectory()) return;
    const file = path.join(info, "exclude");
    const line = `/${rel.split(path.sep).join("/")}`;
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text.split("\n").includes(line)) return;
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(file, `${text.replace(/\n*$/, text ? "\n" : "")}${line}\n`, "utf8");
  } catch {
    // not worth failing a connection over
  }
}

/** Installs the hooks of every platform among these connectors. */
export function installHooksFor(root: string, connectorIds: string[], command: string, args: string[] = []): { adapter: HookAdapter; file?: string; error?: string }[] {
  const adapters = [...new Set(connectorIds.map(adapterForConnector).filter((a): a is HookAdapter => Boolean(a)))];
  return adapters.map((adapter) => {
    try {
      const result = adapter.install(root, hookCommandFor(adapter.platform, command, args));
      if (result.action === "created") excludeLocally(root, adapter.file);
      return { adapter, file: result.file };
    } catch (error) {
      return { adapter, error: (error as Error).message };
    }
  });
}

/** Removes every platform's AgentBrain hooks; returns the labels it stopped. */
export function uninstallAllHooks(root: string): string[] {
  return HOOK_ADAPTERS.filter((adapter) => { try { return adapter.uninstall(root); } catch { return false; } }).map((a) => a.label);
}

export function hookAdapter(platform: string): HookAdapter | undefined {
  return HOOK_ADAPTERS.find((a) => a.platform === platform);
}

/** The hooks a connector's connection brings with it, if its platform has any. */
export function adapterForConnector(connectorId: string): HookAdapter | undefined {
  return HOOK_ADAPTERS.find((a) => a.connectors.includes(connectorId));
}

/** Agents whose hooks are installed in this project: they report their own edits. */
export function hookedAgents(root: string): string[] {
  const hooked = ["claude-code"];
  for (const adapter of HOOK_ADAPTERS) {
    try { if (adapter.installed(root)) hooked.push(adapter.agent); } catch { /* unreadable config */ }
  }
  return hooked;
}

/** One hook call from a platform. Returns what to print (usually nothing). */
export function handlePlatformHook(platform: string, payload: any, fallbackCwd = process.cwd()): string {
  const adapter = hookAdapter(platform);
  if (!adapter) return "";
  try {
    const translated = adapter.translate(payload ?? {}, fallbackCwd);
    if (translated) handleAgentHook(translated, fallbackCwd, adapter.agent, adapter.label);
  } catch {
    // never get in the platform's way
  }
  return adapter.reply ?? "";
}
