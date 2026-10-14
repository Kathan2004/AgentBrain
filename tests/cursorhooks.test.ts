import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readActivity } from "../src/core/activity.js";
import { handleClaudeHook } from "../src/core/claudehooks.js";
import { connectConnector, disconnectConnector } from "../src/core/connectors.js";
import { cursorHooksInstalled, fromCursor, handleCursorHook, installCursorHooks, uninstallCursorHooks } from "../src/core/cursorhooks.js";
import { initStore, listSessions } from "../src/core/store.js";
import { tempRepo } from "./helpers.js";

function repo() {
  const r = tempRepo("agentbrain-cursor-");
  initStore(r);
  return r;
}

describe("Cursor hooks", () => {
  it("are installed when Cursor is connected, keep the developer's own hooks, and go on disconnect", () => {
    const r = repo();
    fs.mkdirSync(path.join(r, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(r, ".cursor/hooks.json"), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }] } }));
    connectConnector(r, "cursor", "agentbrain", ["mcp"]);
    expect(cursorHooksInstalled(r)).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(r, ".cursor/hooks.json"), "utf8"));
    const commands = config.hooks.afterFileEdit.map((h: any) => h.command);
    expect(commands[0]).toBe("./format.sh");
    // Absolute paths: Cursor, a GUI app, may not have the shell's PATH.
    expect(commands[1]).toMatch(/^\S*\/\S+ .*hook cursor 2>\/dev\/null \|\| true$/);
    disconnectConnector(r, "cursor");
    expect(cursorHooksInstalled(r)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(r, ".cursor/hooks.json"), "utf8")).hooks.afterFileEdit).toEqual([{ command: "./format.sh" }]);
    expect(uninstallCursorHooks(r)).toBe(false);
  });

  it("show Cursor's prompts, thoughts, edits and commands live, as Cursor", () => {
    const r = repo();
    const base = { conversation_id: "abc-1", workspace_roots: [r] };
    handleCursorHook({ ...base, hook_event_name: "sessionStart" });
    handleCursorHook({ ...base, hook_event_name: "beforeSubmitPrompt", prompt: "make the sidebar wider" });
    handleCursorHook({ ...base, hook_event_name: "afterAgentThought", text: "Okay, let me think. I'll widen the sidebar to 40 columns in tui.ts." });
    handleCursorHook({ ...base, hook_event_name: "afterFileEdit", file_path: path.join(r, "src/ui/tui.ts"), edits: [] } as any);
    handleCursorHook({ ...base, hook_event_name: "afterShellExecution", command: "npm test" });
    const events = readActivity(r).filter((e) => e.agent === "cursor");
    expect(events.map((e) => e.kind)).toEqual(["session", "prompt", "thought", "edit", "command"]);
    expect(events.find((e) => e.kind === "thought")?.text).toBe("I'll widen the sidebar to 40 columns in tui.ts.");
    expect(events.find((e) => e.kind === "edit")?.files).toEqual(["src/ui/tui.ts"]);
    const session = listSessions(r).find((s) => s.agentId === "cursor");
    expect(session?.sessionId).toBe("cursor-abc-1");
    expect(session?.activity).toBe("working");
  });

  it("aren't credited to Claude Code when Cursor runs Claude's hooks too", () => {
    const r = repo();
    expect(handleClaudeHook({ session_id: "c1", cwd: r, hook_event_name: "UserPromptSubmit", prompt: "hi", cursor_version: "2.0" })).toBe("");
    expect(readActivity(r).filter((e) => e.agent === "claude-code")).toEqual([]);
    expect(fromCursor({ hook_event_name: "afterFileEdit" })).toBeNull();
  });
});
