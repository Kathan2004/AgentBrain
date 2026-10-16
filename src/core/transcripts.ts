import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAgentHook, type ClaudeHookPayload } from "./claudehooks.js";
import { thoughtFrom } from "./thoughts.js";

/**
 * Live reporting for agents that have no hooks. Many of them still write down
 * everything they do: Codex keeps a JSONL "rollout" per session, and Cline, Roo
 * Code and Kilo Code keep each task's messages as JSON in the editor's storage.
 * The control room's daemon follows those files as they grow and records the
 * prompts, thoughts, edits and commands in them, exactly as hooks would, for
 * sessions working in this project. Nothing is backfilled: only what happens
 * after the daemon starts (or in a session that was already live) is recorded.
 */

type Emit = (payload: ClaudeHookPayload) => void;
const said = (text: unknown) => thoughtFrom([{ type: "text", text: String(text ?? "") }]);
/** Connector ids whose work is followed through transcripts. */
export const TRANSCRIPT_AGENTS = ["codex", "codex-app", "codex-ext", "cline", "roo", "kilo"];
const RECENT_MS = 2 * 60 * 60_000;

function under(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/* -------------------------------------------------------------- Codex rollouts */

/** Files touched by an apply_patch call. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}

/** One line of a Codex rollout as AgentBrain events (cwd and session come from the caller). */
export function fromCodexLine(entry: any): Partial<ClaudeHookPayload>[] {
  const p = entry?.payload ?? {};
  if (entry?.type === "event_msg") {
    if (p.type === "user_message" && p.message) return [{ hook_event_name: "UserPromptSubmit", prompt: String(p.message) }];
    if (p.type === "agent_reasoning" || p.type === "agent_message") {
      const thought = said(p.text ?? p.message);
      return thought ? [{ hook_event_name: "Thought", thought }] : [];
    }
    if (p.type === "task_complete") return [{ hook_event_name: "Stop" }];
    return [];
  }
  if (entry?.type !== "response_item") return [];
  if (p.type === "custom_tool_call" && p.name === "apply_patch") {
    return patchFiles(String(p.input ?? "")).map((file) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } }));
  }
  if (p.type === "function_call") {
    let args: any = {};
    try { args = JSON.parse(p.arguments ?? "{}"); } catch { /* partial */ }
    if (p.name === "apply_patch") return patchFiles(String(args.input ?? args.patch ?? "")).map((file) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } }));
    const cmd = Array.isArray(args.command) ? args.command : args.cmd ? [args.cmd] : null;
    if (cmd) {
      // ["bash", "-lc", "npm test"] → "npm test"
      const shown = cmd.length >= 3 && /sh$/.test(cmd[0]) && /^-\w*c$/.test(cmd[1]) ? cmd.slice(2).join(" ") : cmd.join(" ");
      const patched = /apply_patch/.test(shown) ? patchFiles(shown) : [];
      if (patched.length) return patched.map((file) => ({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } }));
      return [{ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: shown } }];
    }
    return [{ hook_event_name: "PostToolUse", tool_name: String(p.name ?? "tool"), tool_input: args }];
  }
  return [];
}

function codexDirs(now = new Date()): string[] {
  const base = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  return [0, 1].map((back) => {
    const d = new Date(now.getTime() - back * 86_400_000);
    return path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  });
}

/* --------------------------------------------------- Cline, Roo Code, Kilo Code */

const CLINE_FAMILY: Record<string, { agent: string; label: string }> = {
  "saoudrizwan.claude-dev": { agent: "cline", label: "Cline" },
  "rooveterinaryinc.roo-cline": { agent: "roo", label: "Roo Code" },
  "kilocode.kilo-code": { agent: "kilo", label: "Kilo Code" },
};
const EDITORS = ["Code", "Code - Insiders", "Cursor", "Windsurf", "VSCodium", "Kiro", "Trae"];

function editorStorage(): string[] {
  const home = os.homedir();
  const bases = process.platform === "darwin" ? [path.join(home, "Library", "Application Support")]
    : process.platform === "win32" ? [process.env.APPDATA ?? path.join(home, "AppData", "Roaming")]
    : [process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")];
  return bases.flatMap((base) => EDITORS.map((editor) => path.join(base, editor, "User", "globalStorage")));
}

const CLINE_EDITS = /^(editedExistingFile|newFileCreated|appliedDiff|insertContent|searchAndReplace|fileEdited|writeToFile)$/;

/** The project file a Cline-family tool message names, if it's in this project. */
function clinePath(root: string, cwd: string | undefined, file: unknown): string | null {
  if (typeof file !== "string" || !file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(cwd ?? root, file);
  return under(root, abs) || (!cwd && fs.existsSync(path.join(root, file))) ? abs : null;
}

/** One Cline-family UI message as AgentBrain events, or null when it isn't about this project. */
export function fromClineMessage(message: any, root: string, cwd?: string): Partial<ClaudeHookPayload>[] | null {
  const kind = message?.say ?? message?.ask;
  const text = String(message?.text ?? "");
  if (kind === "task" || kind === "user_feedback") return text.trim() ? [{ hook_event_name: "UserPromptSubmit", prompt: text }] : [];
  if (kind === "text" || kind === "reasoning" || kind === "completion_result") {
    const thought = said(text);
    return thought ? [{ hook_event_name: "Thought", thought }, ...(kind === "completion_result" ? [{ hook_event_name: "Stop" }] : [])] : [];
  }
  if (kind === "command" && text.trim() && message.type === "say") return [{ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: text.trim() } }];
  if (kind === "tool" && message.type === "say") {
    let tool: any;
    try { tool = JSON.parse(text); } catch { return []; }
    if (!CLINE_EDITS.test(String(tool?.tool ?? ""))) return [];
    const file = clinePath(root, cwd, tool.path);
    return file ? [{ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file } }] : null;
  }
  return [];
}

/* ------------------------------------------------------------------- watching */

interface Followed { size: number; seen: number; project?: boolean; cwd?: string; started?: boolean }

/** Follows every agent transcript on this machine; records those working in `root`. Returns a stop function. */
export function watchTranscripts(root: string, options: { intervalMs?: number; scanMs?: number; codexDirs?: string[]; storage?: string[] } = {}): (() => void) & { tick: () => void } {
  // File clocks are coarser than Date.now(): a file written just after this can look a little older.
  const since = Date.now() - 2000;
  const followed = new Map<string, Followed>();
  const emit = (agent: string, label: string, session: string, cwd: string): Emit => (payload) => {
    const file = payload.tool_input?.file_path;
    const input = typeof file === "string" && !path.isAbsolute(file) ? { ...payload.tool_input, file_path: path.join(cwd, file) } : payload.tool_input;
    try { handleAgentHook({ ...payload, ...(input ? { tool_input: input } : {}), session_id: session, cwd }, cwd, agent, label); } catch { /* keep following */ }
  };

  const followCodex = (file: string, stat: fs.Stats) => {
    let state = followed.get(file);
    if (!state) {
      // Older than the daemon: only what's appended from now on.
      state = { size: stat.mtimeMs < since ? stat.size : 0, seen: 0 };
      followed.set(file, state);
      // Read the header for the session's folder.
      try {
        const head = fs.readFileSync(file, "utf8").split("\n", 1)[0];
        const meta = JSON.parse(head);
        state.cwd = meta?.payload?.cwd;
        // A run AgentBrain started (codex exec) is already reported by AgentBrain itself.
        state.project = Boolean(state.cwd && (state.cwd === root || under(root, state.cwd))) && !/exec/i.test(String(meta?.payload?.originator ?? ""));
      } catch {
        state.project = false;
      }
      if (state.project && state.size === 0) state.started = false;
    }
    if (!state.project || stat.size <= state.size) return;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - state.size);
      fs.readSync(fd, buffer, 0, buffer.length, state.size);
      const text = buffer.toString("utf8");
      const complete = text.lastIndexOf("\n") + 1;
      state.size += Buffer.byteLength(text.slice(0, complete));
      const id = path.basename(file, ".jsonl").replace(/^rollout-/, "").replace(/[^A-Za-z0-9._-]/g, "").slice(-36);
      const send = emit("codex", "Codex", `codex-${id}`, state.cwd!);
      if (state.started === false) { send({ hook_event_name: "SessionStart" }); state.started = true; }
      for (const line of text.slice(0, complete).split("\n")) {
        if (!line.trim()) continue;
        try { for (const event of fromCodexLine(JSON.parse(line))) send(event as ClaudeHookPayload); } catch { /* not JSON */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  const followCline = (file: string, stat: fs.Stats, agent: string, label: string) => {
    let state = followed.get(file);
    if (state && stat.size === state.size) return;
    let messages: any[];
    try { messages = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    if (!Array.isArray(messages)) return;
    if (!state) {
      state = { size: 0, seen: stat.mtimeMs < since ? messages.length : 0 };
      followed.set(file, state);
    }
    state.size = stat.size;
    // Whether the task works in this project: decided by the first file it edits.
    if (state.project === undefined) {
      for (const message of messages) {
        const events = fromClineMessage(message, root);
        if (events === null) { state.project = false; break; }
        if (events.some((e) => e.tool_name === "Edit")) { state.project = true; break; }
      }
    }
    if (!state.project) { state.seen = messages.length; return; }
    const task = path.basename(path.dirname(file)).replace(/[^A-Za-z0-9._-]/g, "");
    const send = emit(agent, label, `${agent}-${task}`, root);
    if (!state.started) { send({ hook_event_name: "SessionStart" }); state.started = true; }
    for (const message of messages.slice(state.seen)) {
      for (const event of fromClineMessage(message, root) ?? []) send(event as ClaudeHookPayload);
    }
    state.seen = messages.length;
  };

  let lastScan = 0;
  let clineFiles: { file: string; agent: string; label: string }[] = [];
  const tick = () => {
    const now = Date.now();
    for (const dir of options.codexDirs ?? codexDirs()) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { continue; }
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          if (now - stat.mtimeMs < RECENT_MS) followCodex(file, stat);
        } catch { /* gone */ }
      }
    }
    // Task folders are many; list them now and then, then only stat the recent ones.
    if (now - lastScan >= (options.scanMs ?? 30_000)) {
      lastScan = now;
      clineFiles = [];
      for (const storage of options.storage ?? editorStorage()) {
        for (const [ext, who] of Object.entries(CLINE_FAMILY)) {
          const tasks = path.join(storage, ext, "tasks");
          let ids: string[] = [];
          try { ids = fs.readdirSync(tasks); } catch { continue; }
          for (const id of ids) {
            const file = path.join(tasks, id, "ui_messages.json");
            try { if (now - fs.statSync(file).mtimeMs < RECENT_MS) clineFiles.push({ file, ...who }); } catch { /* no messages yet */ }
          }
        }
      }
    }
    for (const { file, agent, label } of clineFiles) {
      try { followCline(file, fs.statSync(file), agent, label); } catch { /* gone */ }
    }
  };

  const safeTick = () => { try { tick(); } catch { /* keep going */ } };
  // Learn where every live file already ends before anything new is recorded.
  safeTick();
  const timer = setInterval(safeTick, options.intervalMs ?? 3_000);
  timer.unref?.();
  return Object.assign(() => clearInterval(timer), { tick: safeTick });
}
