import { spawn } from "node:child_process";
import { findOnPath } from "../adapters/process.js";

const VSCODE_BUNDLED = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

/**
 * Brings up the editor on a task's folder: focuses the window that already has
 * it open, or opens one. Never touches a running agent.
 */
export function openInEditor(dir: string): string {
  const code = findOnPath("code") ?? (findOnPath(VSCODE_BUNDLED) ? VSCODE_BUNDLED : null);
  if (!code) throw new Error("VS Code's `code` command was not found.");
  const child = spawn(code, [dir], { detached: true, stdio: "ignore" });
  child.unref();
  return code;
}
