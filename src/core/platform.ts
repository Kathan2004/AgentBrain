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
export function vscodeCommand(): string | null {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]
    : isWindows
      ? [
          path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "Microsoft VS Code", "bin", "code.cmd"),
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code", "bin", "code.cmd"),
        ]
      : ["/usr/bin/code", "/usr/share/code/bin/code", "/snap/bin/code"];
  return findOnPath("code") ?? candidates.find((file) => executable(file)) ?? null;
}

/**
 * How to start AgentBrain itself from another process. Node plus the script
 * path works everywhere; the `agentbrain` shim is a .cmd file on Windows.
 */
export function selfCommand(script = process.argv[1]): { command: string; args: string[] } {
  return { command: process.execPath, args: [fs.realpathSync(script)] };
}
