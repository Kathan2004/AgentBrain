import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBinary, codexBinary } from "./delegate.js";
import { findOnPath, isWindows, spawnSyncPortable, vscodeCommand } from "./platform.js";

/**
 * Every AI coding tool AgentBrain can find on this machine (terminal agents,
 * desktop apps, IDE extensions, IDEs) and how it can work with AgentBrain:
 *
 * - "start": AgentBrain can start tasks in it (push): claude -p, codex exec,
 *   the open VS Code chat, ACP agents.
 * - "pickup": once connected over MCP it sees the project's tasks, picks up
 *   work, reports progress and can review (pull).
 * - "review": it can plan, review and message over MCP, but has no access to
 *   the code (chat apps).
 * - "none": nothing to connect to (said plainly, with the reason).
 *
 * Connecting writes AgentBrain's MCP server into the tool's own config file.
 * Project-level files are preferred; user-level files are only used where the
 * tool has nothing else, and the card says so.
 */
export type ConnectorKind = "terminal" | "app" | "extension" | "ide";
export type Capability = "start" | "pickup" | "review" | "none";

export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind;
  installed: boolean;
  /** Where it was found. */
  location?: string;
  /** undefined when the tool can't tell us. */
  signedIn?: boolean;
  capability: Capability;
  /** AgentBrain's MCP server is in the tool's config. */
  connected: boolean;
  /** What Connect does, or why it can't. */
  connect: { scope: "project" | "user"; file: string } | { manual: string } | null;
  /** How to sign in or install, when that's the missing step. */
  hint?: string;
  note?: string;
}

interface Def {
  id: string;
  name: string;
  kind: ConnectorKind;
  capability: Capability;
  find: () => string | null;
  signedIn?: (found: string) => boolean | undefined;
  /** MCP config: path relative to the project, or absolute (user-level). */
  mcp?: { file: (root: string) => string; scope: "project" | "user"; format: "json" | "codex-toml" | "continue-yaml"; key?: string; rootArg?: boolean };
  manual?: string;
  hint?: string;
  note?: string;
}

const home = os.homedir();
const mac = process.platform === "darwin";
const appSupport = mac ? path.join(home, "Library", "Application Support") : isWindows ? process.env.APPDATA ?? path.join(home, "AppData", "Roaming") : path.join(home, ".config");
const localPrograms = path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs");

function exists(file: string): string | null {
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** A desktop app, wherever each OS installs it. */
function app(macName: string, winDir?: string, linuxBin?: string): () => string | null {
  return () => {
    if (mac) return exists(path.join("/Applications", `${macName}.app`)) ?? exists(path.join(home, "Applications", `${macName}.app`));
    if (isWindows) return winDir ? exists(path.join(localPrograms, winDir)) ?? exists(path.join(process.env.ProgramFiles ?? "C:\\Program Files", winDir)) : null;
    return linuxBin ? findOnPath(linuxBin) : null;
  };
}

/** Editors whose extension folders we look in. */
function extensionDirs(): string[] {
  return [".vscode", ".vscode-insiders", ".cursor", ".windsurf", ".vscode-oss", ".kiro"].map((d) => path.join(home, d, "extensions"));
}

const installedExtensions = (() => {
  let cache: { at: number; ids: Map<string, string> } | null = null;
  return () => {
    if (cache && Date.now() - cache.at < 30_000) return cache.ids;
    const ids = new Map<string, string>();
    for (const dir of extensionDirs()) {
      try {
        for (const entry of fs.readdirSync(dir)) {
          const id = entry.toLowerCase().replace(/-\d[\w.-]*$/, "");
          if (!ids.has(id)) ids.set(id, path.join(dir, entry));
        }
      } catch {
        // editor not installed
      }
    }
    // Copilot ships inside VS Code itself now.
    const code = vscodeCommand();
    if (code && mac) {
      const builtIn = path.resolve(path.dirname(code), "..", "extensions", "copilot");
      if (exists(builtIn)) ids.set("github.copilot-chat", builtIn);
    }
    cache = { at: Date.now(), ids };
    return ids;
  };
})();

function extension(...ids: string[]): () => string | null {
  return () => {
    const found = installedExtensions();
    for (const id of ids) if (found.has(id)) return found.get(id)!;
    return null;
  };
}

const onPath = (...names: string[]) => () => names.map((n) => findOnPath(n)).find(Boolean) ?? null;

function claudeSignedIn(bin: string): boolean | undefined {
  try {
    const r = spawnSyncPortable(bin, ["auth", "status"], { encoding: "utf8", timeout: 10_000 });
    return /"loggedIn"\s*:\s*true/.test(String(r.stdout ?? ""));
  } catch {
    return undefined;
  }
}

function codexSignedIn(bin: string): boolean | undefined {
  try {
    const r = spawnSyncPortable(bin, ["login", "status"], { encoding: "utf8", timeout: 10_000 });
    return r.status === 0 && !/not logged in/i.test(`${r.stdout}${r.stderr}`);
  } catch {
    return undefined;
  }
}

const project = (rel: string) => (root: string) => path.join(root, rel);
const user = (abs: string) => () => abs;

export const DEFS: Def[] = [
  // ---- terminal agents
  { id: "claude-code", name: "Claude Code", kind: "terminal", capability: "start", find: () => claudeBinary(), signedIn: claudeSignedIn,
    mcp: { file: project(".mcp.json"), scope: "project", format: "json", key: "mcpServers" }, hint: "claude auth login",
    note: "Runs tasks in the background (claude -p). The Claude app's Code tab and the VS Code extension use the same connection." },
  { id: "codex", name: "Codex", kind: "terminal", capability: "start", find: () => codexBinary(), signedIn: codexSignedIn,
    mcp: { file: user(path.join(home, ".codex", "config.toml")), scope: "user", format: "codex-toml" }, hint: "codex login",
    note: "Runs tasks in the background (codex exec). Codex only reads MCP servers from your user config." },
  { id: "gemini", name: "Gemini CLI", kind: "terminal", capability: "start", find: onPath("gemini"),
    mcp: { file: project(".gemini/settings.json"), scope: "project", format: "json", key: "mcpServers" }, hint: "npm install -g @google/gemini-cli" },
  { id: "copilot-cli", name: "GitHub Copilot CLI", kind: "terminal", capability: "pickup", find: onPath("copilot"),
    mcp: { file: user(path.join(home, ".copilot", "mcp-config.json")), scope: "user", format: "json", key: "mcpServers" } },
  { id: "cursor-agent", name: "Cursor CLI", kind: "terminal", capability: "pickup", find: onPath("cursor-agent"),
    mcp: { file: project(".cursor/mcp.json"), scope: "project", format: "json", key: "mcpServers" } },
  { id: "opencode", name: "OpenCode", kind: "terminal", capability: "pickup", find: onPath("opencode"),
    mcp: { file: project("opencode.json"), scope: "project", format: "json", key: "mcp" } },
  { id: "aider", name: "Aider", kind: "terminal", capability: "pickup", find: onPath("aider"), manual: "Aider has no MCP support; AgentBrain hands it the brief as a file: agentbrain run aider" },
  { id: "goose", name: "Goose", kind: "terminal", capability: "pickup", find: onPath("goose"), manual: "Add an extension in Goose: goose configure → Add Extension → Command-line Extension → agentbrain mcp" },
  { id: "amp", name: "Amp", kind: "terminal", capability: "pickup", find: onPath("amp"), manual: "Add to Amp's settings: \"amp.mcpServers\": { \"agentbrain\": { \"command\": \"agentbrain\", \"args\": [\"mcp\"] } }" },
  { id: "qwen", name: "Qwen Code", kind: "terminal", capability: "pickup", find: onPath("qwen"),
    mcp: { file: project(".qwen/settings.json"), scope: "project", format: "json", key: "mcpServers" } },

  // ---- desktop apps
  { id: "claude-app", name: "Claude app (chat)", kind: "app", capability: "review", find: app("Claude", "Claude", "claude-desktop"),
    mcp: { file: user(path.join(appSupport, "Claude", "claude_desktop_config.json")), scope: "user", format: "json", key: "mcpServers", rootArg: true },
    note: "Chat can plan, review, recall memory and message agents; it has no access to the code. Its Code tab is Claude Code." },
  { id: "chatgpt-app", name: "ChatGPT app", kind: "app", capability: "none", find: app("ChatGPT", "ChatGPT"),
    note: "ChatGPT only connects to remote MCP servers, not local ones like AgentBrain. Use Codex for coding work." },
  { id: "codex-app", name: "Codex app", kind: "app", capability: "start", find: app("Codex", "Codex"),
    mcp: { file: user(path.join(home, ".codex", "config.toml")), scope: "user", format: "codex-toml" }, note: "Shares the Codex connection." },
  { id: "cursor", name: "Cursor", kind: "ide", capability: "pickup", find: app("Cursor", "cursor", "cursor"),
    mcp: { file: project(".cursor/mcp.json"), scope: "project", format: "json", key: "mcpServers" } },
  { id: "windsurf", name: "Windsurf", kind: "ide", capability: "pickup", find: app("Windsurf", "Windsurf", "windsurf"),
    mcp: { file: user(path.join(home, ".codeium", "windsurf", "mcp_config.json")), scope: "user", format: "json", key: "mcpServers", rootArg: true } },
  { id: "vscode", name: "VS Code", kind: "ide", capability: "start", find: () => vscodeCommand(),
    mcp: { file: project(".vscode/mcp.json"), scope: "project", format: "json", key: "servers" }, note: "Tasks go to the Copilot chat you have open." },
  { id: "kiro", name: "Kiro", kind: "ide", capability: "pickup", find: app("Kiro", "Kiro", "kiro"),
    mcp: { file: project(".kiro/settings/mcp.json"), scope: "project", format: "json", key: "mcpServers" } },
  { id: "zed", name: "Zed", kind: "ide", capability: "pickup", find: app("Zed", "Zed", "zed"),
    manual: "In Zed: Agent panel → Settings → Add Custom Server, command: agentbrain mcp" },
  { id: "jetbrains", name: "JetBrains IDEs", kind: "ide", capability: "pickup",
    find: () => ["IntelliJ IDEA", "IntelliJ IDEA CE", "PyCharm", "PyCharm CE", "WebStorm", "GoLand", "PhpStorm", "RubyMine", "CLion", "Rider", "Android Studio"].map((n) => app(n)()).find(Boolean) ?? null,
    manual: "In the IDE: Settings → Tools → AI Assistant → Model Context Protocol → Add, command: agentbrain mcp" },
  { id: "warp", name: "Warp", kind: "app", capability: "pickup", find: app("Warp", "Warp", "warp-terminal"),
    manual: "In Warp: Settings → AI → MCP Servers → Add, command: agentbrain mcp" },
  { id: "ollama", name: "Ollama", kind: "app", capability: "none", find: app("Ollama", "Ollama", "ollama"),
    note: "A local model as a worker, through Claude Code's CLI and the same AgentBrain memory: agentbrain local setup." },

  // ---- IDE extensions
  { id: "copilot", name: "GitHub Copilot", kind: "extension", capability: "start", find: extension("github.copilot-chat", "github.copilot"),
    mcp: { file: project(".vscode/mcp.json"), scope: "project", format: "json", key: "servers" }, note: "Shares the VS Code connection." },
  { id: "claude-code-ext", name: "Claude Code for VS Code", kind: "extension", capability: "pickup", find: extension("anthropic.claude-code"),
    mcp: { file: project(".mcp.json"), scope: "project", format: "json", key: "mcpServers" }, note: "Shares the Claude Code connection." },
  { id: "codex-ext", name: "Codex for VS Code", kind: "extension", capability: "pickup", find: extension("openai.chatgpt"),
    mcp: { file: user(path.join(home, ".codex", "config.toml")), scope: "user", format: "codex-toml" }, note: "Shares the Codex connection." },
  { id: "cline", name: "Cline", kind: "extension", capability: "pickup", find: extension("saoudrizwan.claude-dev"),
    mcp: { file: user(path.join(appSupport, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")), scope: "user", format: "json", key: "mcpServers", rootArg: true } },
  { id: "roo", name: "Roo Code", kind: "extension", capability: "pickup", find: extension("rooveterinaryinc.roo-cline"),
    mcp: { file: project(".roo/mcp.json"), scope: "project", format: "json", key: "mcpServers" } },
  { id: "kilo", name: "Kilo Code", kind: "extension", capability: "pickup", find: extension("kilocode.kilo-code"),
    mcp: { file: project(".kilocode/mcp.json"), scope: "project", format: "json", key: "mcpServers" } },
  { id: "continue", name: "Continue", kind: "extension", capability: "pickup", find: extension("continue.continue"),
    mcp: { file: project(".continue/mcpServers/agentbrain.yaml"), scope: "project", format: "continue-yaml" } },
  { id: "amazon-q", name: "Amazon Q Developer", kind: "extension", capability: "pickup", find: extension("amazonwebservices.amazon-q-vscode"),
    mcp: { file: project(".amazonq/mcp.json"), scope: "project", format: "json", key: "mcpServers" } },
  { id: "gemini-assist", name: "Gemini Code Assist", kind: "extension", capability: "pickup", find: extension("google.geminicodeassist"),
    mcp: { file: project(".gemini/settings.json"), scope: "project", format: "json", key: "mcpServers" }, note: "Shares the Gemini CLI connection." },
  { id: "augment", name: "Augment", kind: "extension", capability: "pickup", find: extension("augment.vscode-augment"),
    manual: "In Augment: Settings → MCP → Add server, command: agentbrain mcp" },
  { id: "cody", name: "Cody", kind: "extension", capability: "none", find: extension("sourcegraph.cody-ai"), note: "Cody has no local MCP agent mode." },
  { id: "tabnine", name: "Tabnine", kind: "extension", capability: "none", find: extension("tabnine.tabnine-vscode"), note: "Completion only; no agent to connect." },
];

/* ---------------------------------------------------------------- config files */

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function hasAgentBrain(def: Def, root: string): boolean {
  if (!def.mcp) return false;
  const file = def.mcp.file(root);
  if (!fs.existsSync(file)) return false;
  if (def.mcp.format === "json") return Boolean(readJson(file)?.[def.mcp.key!]?.agentbrain);
  return /agentbrain/.test(fs.readFileSync(file, "utf8"));
}

function entry(def: Def, root: string, command: string, args: string[]): Record<string, unknown> {
  const full = def.mcp?.rootArg ? [...args, "--root", root] : args;
  if (def.id === "vscode" || def.id === "copilot") return { type: "stdio", command, args: [...args, "--root", "${workspaceFolder}"] };
  if (def.mcp?.key === "mcp") return { type: "local", command: [command, ...full], enabled: true };
  return { command, args: full };
}

/** Lists what is installed (and every known tool, installed or not, with `all`). */
export function detectConnectors(root: string, options: { all?: boolean } = {}): Connector[] {
  return DEFS.map((def) => {
    const location = def.find();
    const installed = Boolean(location);
    const connector: Connector = {
      id: def.id,
      name: def.name,
      kind: def.kind,
      installed,
      ...(location ? { location } : {}),
      capability: def.capability,
      connected: installed && hasAgentBrain(def, root),
      connect: def.mcp ? { scope: def.mcp.scope, file: def.mcp.scope === "project" ? path.relative(root, def.mcp.file(root)) : def.mcp.file(root) } : def.manual ? { manual: def.manual } : null,
      ...(def.hint ? { hint: def.hint } : {}),
      ...(def.note ? { note: def.note } : {}),
    };
    if (installed && def.signedIn) connector.signedIn = def.signedIn(location!);
    return connector;
  }).filter((c) => options.all || c.installed);
}

export function findConnector(id: string): Def {
  const def = DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`Unknown connector "${id}". Known: ${DEFS.map((d) => d.id).join(", ")}`);
  return def;
}

/** Adds AgentBrain to the tool's MCP config, keeping everything else in the file. */
export function connectConnector(root: string, id: string, command: string, args: string[]): { file: string; action: "created" | "updated" | "unchanged" } {
  const def = findConnector(id);
  if (!def.mcp) throw new Error(def.manual ?? `${def.name} can't be connected: ${def.note ?? "no MCP support"}.`);
  const file = def.mcp.file(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  if (def.mcp.format === "json") {
    const config = existed ? readJson(file) : {};
    if (!config) throw new Error(`${file} isn't plain JSON (comments?); add AgentBrain by hand: "agentbrain": ${JSON.stringify(entry(def, root, command, args))}`);
    const servers = (config[def.mcp.key!] ??= {});
    const wanted = entry(def, root, command, args);
    if (JSON.stringify(servers.agentbrain) === JSON.stringify(wanted)) return { file, action: "unchanged" };
    servers.agentbrain = wanted;
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } else if (def.mcp.format === "codex-toml") {
    const text = existed ? fs.readFileSync(file, "utf8") : "";
    if (/^\[mcp_servers\.agentbrain\]/m.test(text)) return { file, action: "unchanged" };
    const toml = `\n[mcp_servers.agentbrain]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
    fs.writeFileSync(file, `${text.replace(/\n*$/, "\n")}${toml}`, "utf8");
  } else {
    const yaml = `name: AgentBrain\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: agentbrain\n    command: ${JSON.stringify(command)}\n    args: ${JSON.stringify(args)}\n`;
    if (existed && fs.readFileSync(file, "utf8") === yaml) return { file, action: "unchanged" };
    fs.writeFileSync(file, yaml, "utf8");
  }
  return { file, action: existed ? "updated" : "created" };
}

/** Removes AgentBrain from the tool's MCP config (only AgentBrain's entry). */
export function disconnectConnector(root: string, id: string): boolean {
  const def = findConnector(id);
  if (!def.mcp) return false;
  const file = def.mcp.file(root);
  if (!fs.existsSync(file)) return false;
  if (def.mcp.format === "json") {
    const config = readJson(file);
    if (!config?.[def.mcp.key!]?.agentbrain) return false;
    delete config[def.mcp.key!].agentbrain;
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return true;
  }
  if (def.mcp.format === "codex-toml") {
    const text = fs.readFileSync(file, "utf8");
    const next = text.replace(/\n?\[mcp_servers\.agentbrain\]\n(?:(?!\[)[^\n]*\n?)*/m, "\n");
    if (next === text) return false;
    fs.writeFileSync(file, next.replace(/^\n+/, ""), "utf8");
    return true;
  }
  fs.rmSync(file);
  return true;
}
