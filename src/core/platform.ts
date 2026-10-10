import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Everything that differs between macOS, Linux and Windows in one place:
 * finding executables (Windows adds .cmd/.exe), starting them (Node can't
 * start a .cmd/.bat file without a shell, and cmd.exe has its own quoting),
 * opening a URL, and where editors install themselves.
 */
export const isWindows = process.platform === "win32";

/** Windows' executable extensions, in PATHEXT order. */
function extensions(): string[] {
  if (!isWindows) return [""];
  const ext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return ["", ...ext.map((e) => e.toLowerCase())];
}

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (isWindows) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of `command` on PATH (or of an explicit path), or null. */
export function findOnPath(command: string, envPath = process.env.PATH ?? process.env.Path ?? ""): string | null {
  const explicit = path.isAbsolute(command) || command.includes("/") || (isWindows && command.includes("\\"));
  if (explicit) {
    for (const ext of extensions()) if (executable(command + ext)) return path.resolve(command + ext);
    return null;
  }
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions()) {
      const candidate = path.join(dir, command + ext);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

const META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * cmd.exe quoting for one argument (the approach of the cross-spawn package).
 * Arguments to a .cmd/.bat file are parsed twice (once by cmd.exe, again when
 * the batch file expands %*), so their metacharacters are escaped twice.
 */
function cmdQuote(arg: string, twice: boolean): string {
  // Newlines can't survive cmd.exe; callers pass long text through stdin or files instead.
  const quoted = `"${arg.replace(/[\r\n]+/g, " ").replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const once = quoted.replace(META, "^$1");
  return twice ? once.replace(META, "^$1") : once;
}

function cmdLine(command: string, args: string[]): string {
  return [cmdQuote(command, false), ...args.map((a) => cmdQuote(a, true))].join(" ");
}

const needsShell = (command: string) => isWindows && /\.(cmd|bat)$/i.test(command);

/** spawn() that also works for Windows .cmd/.bat shims (npm-installed CLIs, VS Code's `code`). */
export function spawnPortable(command: string, args: string[], options: SpawnOptions = {}) {
  if (!needsShell(command)) return spawn(command, args, options);
  return spawn(cmdLine(command, args), [], { ...options, shell: true, windowsVerbatimArguments: true });
}

export function spawnSyncPortable(command: string, args: string[], options: SpawnSyncOptions = {}) {
  if (!needsShell(command)) return spawnSync(command, args, options);
  return spawnSync(cmdLine(command, args), [], { ...options, shell: true, windowsVerbatimArguments: true });
}

/** Opens a URL in the default browser. */
export function openUrl(url: string): void {
  try {
    const child = process.platform === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : isWindows
        ? spawn("cmd", ["/c", "start", '""', url.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsVerbatimArguments: true })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser here; callers print the URL anyway
  }
}

/** VS Code's `code` command: on PATH, or where the installer puts it on each OS. */
/**
 * Agents AgentBrain starts are their own sessions, even when AgentBrain itself
 * was started by one (an MCP server under Claude Code, a delegate call, a hook).
 * Claude Code refuses to start when it sees these markers of a parent session.
 */
export function clearParentSession(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[key];
}

/** Where npm, pipx and friends put tools installed without root (often missing from PATH). */
export function userBinDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    process.env.npm_config_prefix && (isWindows ? process.env.npm_config_prefix : path.join(process.env.npm_config_prefix, "bin")),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    isWindows ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm") : "",
    isWindows ? "" : "/opt/homebrew/bin",
  ];
  return [...new Set(dirs.filter((d): d is string => Boolean(d)))];
}

/** `command` on PATH, or in a user-level install folder (e.g. `npm i -g --prefix ~/.local`). */
export function findTool(command: string): string | null {
  if (process.env.AGENTBRAIN_ONLY_PATH) return findOnPath(command);
  return findOnPath(command) ?? findOnPath(command, userBinDirs().join(path.delimiter));
}

export function vscodeCommand(): string | null {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]
    : isWindows
      ? [
          path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "Microsoft VS Code", "bin", "code.cmd"),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code", "bin", "code.cmd"),
        ]
      : ["/usr/bin/code", "/usr/share/code/bin/code", "/snap/bin/code"];
  if (process.env.AGENTBRAIN_ONLY_PATH) return findOnPath("code");
  return findOnPath("code") ?? candidates.find((file) => executable(file)) ?? null;
}

/**
 * How to start AgentBrain itself from another process. Node plus the script
 * path works everywhere; the `agentbrain` shim is a .cmd file on Windows.
 */
export function selfCommand(script = process.argv[1]): { command: string; args: string[] } {
  return { command: process.execPath, args: [fs.realpathSync(script)] };
}

let resolvedGit: string | undefined;

/**
 * The git binary. On macOS /usr/bin/git is a shim that asks xcrun for the real
 * one on every call (0.3-1 s each); AgentBrain runs git constantly, so it
 * resolves the real binary once.
 */
export function gitBinary(): string {
  if (resolvedGit) return resolvedGit;
  resolvedGit = "git";
  if (process.platform === "darwin" && findOnPath("git") === "/usr/bin/git") {
    try {
      const real = spawnSync("xcrun", ["--find", "git"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim();
      if (real && executable(real)) resolvedGit = real;
    } catch {
      // keep the shim
    }
  }
  return resolvedGit;
}
