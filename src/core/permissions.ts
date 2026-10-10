import fs from "node:fs";
import path from "node:path";
import { getProject, saveProject } from "./store.js";

/**
 * How much the agents AgentBrain starts may do without asking.
 * "ask": each tool's own defaults (edits allowed, commands need approval).
 * "all": every agent runs in its own "allow everything" mode, so nobody has
 * to click Allow or switch a chat to bypass mode before delegation works.
 * Opt-in per project with `agentbrain permissions all`.
 */
export type PermissionMode = "ask" | "all";

export function permissionMode(root: string): PermissionMode {
  try {
    return getProject(root).permissions === "all" ? "all" : "ask";
  } catch {
    return "ask";
  }
}

/** Each terminal agent's documented "don't ask" flag. */
export const ALLOW_ALL_FLAGS: Record<string, string[]> = {
  "claude-code": ["--permission-mode", "bypassPermissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--yolo"],
  copilot: ["--allow-all-tools"],
  cursor: ["--force"],
};

/** VS Code settings that let Copilot's agent mode run tools and terminal commands without asking. */
export const VSCODE_AUTO_APPROVE = ["chat.tools.global.autoApprove", "chat.tools.autoApprove"];

/** Sets or clears auto-approval in this project's .vscode/settings.json (workspace only, never user settings). */
export function setVscodeAutoApprove(root: string, on: boolean): string {
  const file = path.join(root, ".vscode", "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      settings = text.trim() ? JSON.parse(text) : {};
    } catch {
      // JSONC with comments: don't risk rewriting the developer's file.
      throw new Error(`${file} has comments or isn't plain JSON; set "${VSCODE_AUTO_APPROVE[0]}": ${on} there yourself.`);
    }
  }
  for (const key of VSCODE_AUTO_APPROVE) {
    if (on) settings[key] = true;
    else delete settings[key];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return file;
}

/**
 * VS Code reads workspace settings from the folder a window has open, and
 * AgentBrain often opens Copilot in a task's own worktree: each one needs the
 * setting too. Called for new worktrees; quiet when it can't write.
 */
export function applyToWorkdir(root: string, workdir: string): void {
  if (permissionMode(root) !== "all" || path.resolve(workdir) === path.resolve(root)) return;
  excludeFromGit(root);
  try {
    setVscodeAutoApprove(workdir, true);
  } catch {
    // A worktree with its own commented settings file: leave it.
  }
}

/** Keeps the per-machine setting out of commits in every worktree, whatever their .gitignore says. */
function excludeFromGit(root: string): void {
  const exclude = path.join(root, ".git", "info", "exclude");
  try {
    if (!fs.existsSync(path.join(root, ".git"))) return;
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (text.split(/\r?\n/).includes(".vscode/settings.json")) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}.vscode/settings.json\n`);
  } catch { /* .git is a file (a worktree itself) or unwritable */ }
}

function worktreeDirs(root: string): string[] {
  const dir = path.join(root, ".agentbrain", "worktrees");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
}

export function setPermissionMode(root: string, mode: PermissionMode): { mode: PermissionMode; vscode?: string; worktrees: number; warning?: string } {
  const project = getProject(root);
  if (mode === "all") project.permissions = "all";
  else delete project.permissions;
  saveProject(root, project);
  if (mode === "all") excludeFromGit(root);
  let worktrees = 0;
  for (const dir of worktreeDirs(root)) {
    try {
      setVscodeAutoApprove(dir, mode === "all");
      worktrees++;
    } catch { /* commented settings file: skipped */ }
  }
  try {
    return { mode, vscode: setVscodeAutoApprove(root, mode === "all"), worktrees };
  } catch (error) {
    return { mode, worktrees, warning: (error as Error).message };
  }
}
