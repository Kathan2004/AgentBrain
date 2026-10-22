import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { brainDir } from "../core/paths.js";
import { openUrl } from "../core/platform.js";

/**
 * The control room runs in the background, one per repo, so `agentbrain on`
 * from any terminal (or from inside an agent) can start it or find it again.
 */
export interface UiState {
  pid: number;
  url: string;
  startedAt: string;
  firstOpened?: string;
}

export function uiStateFile(root: string): string {
  return path.join(brainDir(root), "ui.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Written by the server itself once it is listening. Holds the access token, so it is owner-only, and it
 * stays after the server stops so the next start reuses the token (runningUi checks the pid).
 */
export function writeUiState(root: string, url: string): void {
  const file = uiStateFile(root);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString(), firstOpened: firstOpened(root) ?? new Date().toISOString() } satisfies UiState), { mode: 0o600 });
}

export function runningUi(root: string): UiState | null {
  try {
    const state = JSON.parse(fs.readFileSync(uiStateFile(root), "utf8")) as UiState;
    return alive(state.pid) ? state : null;
  } catch {
    return null;
  }
}

/** Starts `agentbrain ui` detached and waits until it reports its URL. */
export async function startUiDaemon(root: string, command: string, args: string[], timeoutMs = 15_000): Promise<UiState> {
  const existing = runningUi(root);
  if (existing) return existing;
  const log = fs.openSync(path.join(brainDir(root), "ui.log"), "a");
  const child = spawn(command, [...args, "ui"], { cwd: root, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  fs.closeSync(log);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = runningUi(root);
    if (state && state.pid === child.pid) return state;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`The control room did not start; see ${path.join(brainDir(root), "ui.log")}`);
}

/**
 * True once the entry script's mtime has moved away from the mtime the daemon started
 * with, and its size has stopped changing across two consecutive polls (a rebuild still
 * writing the file reports a growing or shrinking size, not a stable one).
 */
export function codeRebuilt(startMtimeMs: number, previous: { mtimeMs: number; size: number } | undefined, current: { mtimeMs: number; size: number }): boolean {
  if (current.mtimeMs === startMtimeMs) return false;
  return previous !== undefined && previous.mtimeMs === current.mtimeMs && previous.size === current.size;
}

/**
 * Spawns a fresh `agentbrain ui` on the given port, detached, the same way startUiDaemon
 * does, and waits for it to write its pid to ui.json. Used when this process is replacing
 * itself after a rebuild, so the spawned process is told (via AGENTBRAIN_UI_RESTART) to skip
 * the "already running" check: the process it is replacing is still alive, mid-shutdown.
 */
export async function restartUiDaemon(root: string, command: string, args: string[], port: number, timeoutMs = 15_000): Promise<UiState> {
  const log = fs.openSync(path.join(brainDir(root), "ui.log"), "a");
  const child = spawn(command, [...args, "ui", "--port", String(port)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, AGENTBRAIN_UI_RESTART: "1" },
  });
  child.unref();
  fs.closeSync(log);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = runningUi(root);
    if (state && state.pid === child.pid) return state;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`The control room did not restart; see ${path.join(brainDir(root), "ui.log")}`);
}

export async function stopUiDaemon(root: string): Promise<boolean> {
  const state = runningUi(root);
  if (!state) return false;
  process.kill(state.pid, "SIGTERM");
  for (let i = 0; i < 20 && alive(state.pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive(state.pid)) process.kill(state.pid, "SIGKILL");
  return true;
}

export function openBrowser(url: string): void {
  openUrl(url);
}

/** The token of the last control room for this repo, so an open browser tab keeps working after a restart. */
export function previousToken(root: string): string | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(uiStateFile(root), "utf8")) as UiState;
    return /#token=([0-9a-f]{48})$/.exec(state.url)?.[1];
  } catch {
    return undefined;
  }
}

/** When the control room first ran in this repo, whether or not it is running now. */
export function firstOpened(root: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(uiStateFile(root), "utf8")) as UiState).firstOpened;
  } catch {
    return undefined;
  }
}

/** Whether to open the dashboard by itself: only the first time, in an interactive terminal, outside CI. */
export function shouldAutoOpen(root?: string, env: NodeJS.ProcessEnv = process.env, tty = Boolean(process.stdout.isTTY)): boolean {
  if (root && firstOpened(root)) return false;
  if (env.AGENTBRAIN_NO_OPEN || env.CI) return false;
  return tty;
}
