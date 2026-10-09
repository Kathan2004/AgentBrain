import { spawnPortable, vscodeCommand } from "../core/platform.js";

/**
 * Brings up the editor on a task's folder: focuses the window that already has
 * it open, or opens one. Never touches a running agent.
 */
export function openInEditor(dir: string): string {
  const code = vscodeCommand();
  if (!code) throw new Error("VS Code's `code` command was not found.");
  const child = spawnPortable(code, [dir], { detached: true, stdio: "ignore" });
  child.unref();
  return code;
}
