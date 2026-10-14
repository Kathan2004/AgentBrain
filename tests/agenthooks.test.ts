import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readActivity } from "../src/core/activity.js";
import { handleClaudeHook } from "../src/core/claudehooks.js";
import { adapterForConnector, handlePlatformHook, hookAdapter, hookedAgents, installHooksFor, uninstallAllHooks } from "../src/core/agenthooks.js";
import { fromClineMessage, fromCodexLine, patchFiles, watchTranscripts } from "../src/core/transcripts.js";
import { AgentBrainMcpServer } from "../src/mcp/server.js";
import { initStore, listSessions } from "../src/core/store.js";
import { tempRepo } from "./helpers.js";

function repo() {
  const r = tempRepo("agentbrain-hooks-");
  initStore(r);
  return r;
}
const kinds = (r: string, agent: string) => readActivity(r).filter((e) => e.agent === agent).map((e) => e.kind);

describe("hooks for every connected agent", () => {
  it("each platform with hooks gets them from its connection, alongside the developer's own, and loses them on off", () => {
    const r = repo();
    fs.mkdirSync(path.join(r, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(r, ".gemini/settings.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, hooks: { AfterTool: [{ matcher: "*", hooks: [{ type: "command", command: "./lint.sh" }] }] } }));
    const results = installHooksFor(r, ["gemini", "windsurf", "copilot", "copilot-cli", "zed"], "agentbrain", []);
    expect(results.map((x) => x.adapter.platform).sort()).toEqual(["copilot", "gemini", "windsurf"]);
    expect(results.every((x) => !x.error)).toBe(true);
    const gemini = JSON.parse(fs.readFileSync(path.join(r, ".gemini/settings.json"), "utf8"));
    expect(gemini.mcpServers.other).toBeTruthy();
    expect(gemini.hooks.AfterTool[0].hooks[0].command).toBe("./lint.sh");
    expect(gemini.hooks.AfterTool[1].hooks[0].command).toMatch(/hook gemini 2>\/dev\/null \|\| true$/);
    const copilot = JSON.parse(fs.readFileSync(path.join(r, ".github/hooks/agentbrain.json"), "utf8"));
    expect(copilot.version).toBe(1);
    expect(copilot.hooks.postToolUse[0].bash).toMatch(/hook copilot/);
    expect(hookedAgents(r).sort()).toEqual(["claude-code", "copilot", "gemini", "windsurf"]);
    // Installing twice changes nothing.
    expect(hookAdapter("windsurf")!.install(r, "agentbrain hook windsurf").action).toBe("updated");
    expect(hookAdapter("windsurf")!.install(r, "agentbrain hook windsurf").action).toBe("unchanged");
    expect(uninstallAllHooks(r).sort()).toEqual(["Gemini CLI", "GitHub Copilot", "Windsurf"]);
    expect(fs.existsSync(path.join(r, ".github/hooks/agentbrain.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(r, ".gemini/settings.json"), "utf8")).hooks.AfterTool).toHaveLength(1);
    expect(adapterForConnector("cursor-agent")?.platform).toBe("cursor");
    expect(adapterForConnector("zed")).toBeUndefined();
  });

  it("Gemini CLI's events show up as Gemini's prompts, edits, commands and thoughts", () => {
    const r = repo();
    const base = { session_id: "g-1", cwd: r };
    handlePlatformHook("gemini", { ...base, hook_event_name: "SessionStart" });
    handlePlatformHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "fix the date parser" });
    handlePlatformHook("gemini", { ...base, hook_event_name: "AfterTool", tool_name: "replace", tool_input: { file_path: path.join(r, "src/date.ts") } });
    handlePlatformHook("gemini", { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "npm test" } });
    expect(handlePlatformHook("gemini", { ...base, hook_event_name: "AfterAgent", prompt_response: "I fixed the parser so two-digit years are read as 20xx." })).toBe("{}");
    expect(kinds(r, "gemini")).toEqual(["session", "prompt", "edit", "command", "thought"]);
    expect(readActivity(r).find((e) => e.kind === "edit")?.files).toEqual(["src/date.ts"]);
  });

  it("Windsurf and Copilot events show up as theirs too", () => {
    const r = repo();
    const ws = { trajectory_id: "t-9", execution_id: "e1" };
    handlePlatformHook("windsurf", { ...ws, agent_action_name: "pre_user_prompt", tool_info: { user_prompt: "rename the flag" } }, r);
    handlePlatformHook("windsurf", { ...ws, agent_action_name: "post_write_code", tool_info: { file_path: path.join(r, "src/flags.ts"), edits: [] } }, r);
    handlePlatformHook("windsurf", { ...ws, agent_action_name: "post_run_command", tool_info: { command_line: "npm run build", cwd: r } }, r);
    expect(kinds(r, "windsurf")).toEqual(["prompt", "edit", "command"]);

    // Copilot CLI: camelCase, no session id, tool args as a JSON string.
    handlePlatformHook("copilot", { cwd: r, timestamp: 1, prompt: "add a test" , hookEventName: "userPromptSubmitted" });
    handlePlatformHook("copilot", { cwd: r, toolName: "edit", toolArgs: JSON.stringify({ path: path.join(r, "tests/a.test.ts") }) });
    handlePlatformHook("copilot", { cwd: r, toolName: "bash", toolArgs: JSON.stringify({ command: "npx vitest run" }) });
    expect(kinds(r, "copilot")).toEqual(["prompt", "edit", "command"]);
    expect(listSessions(r).filter((s) => s.agentId === "copilot")).toHaveLength(1);
    // VS Code also runs Claude's hook file; those payloads aren't Claude's.
    expect(handleClaudeHook({ hookEventName: "PostToolUse", sessionId: "v1", cwd: r } as any)).toBe("");
    expect(kinds(r, "claude-code")).toEqual([]);
  });
});

describe("agents without hooks", () => {
  it("are present while their MCP connection is open, and leave when it closes", async () => {
    const r = repo();
    const out: string[] = [];
    const server = new AgentBrainMcpServer({ root: r, output: { write: (s: string) => (out.push(s), true) } as any, log: () => {} });
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Zed" } } }));
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agentbrain_list_tasks", arguments: {} } }));
    let session = listSessions(r).find((s) => s.agentId === "zed");
    expect(session?.activity).toBe("working");
    expect(session?.endedAt).toBeUndefined();
    server.close("stdin closed");
    session = listSessions(r).find((s) => s.agentId === "zed");
    expect(session?.endedAt).toBeTruthy();
    expect(kinds(r, "zed")).toEqual(["session", "session"]);
  });

  it("an agent whose hooks report for it gets no second session from MCP", async () => {
    const r = repo();
    const server = new AgentBrainMcpServer({ root: r, output: { write: () => true } as any, log: () => {} });
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code" } } }));
    await (server as any).receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    server.close("done");
    expect(listSessions(r)).toEqual([]);
  });

  it("Codex's rollout and Cline-family task logs read as prompts, thoughts, edits and commands", () => {
    expect(patchFiles("*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n*** End Patch")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(fromCodexLine({ type: "event_msg", payload: { type: "user_message", message: "speed up the build" } })[0].hook_event_name).toBe("UserPromptSubmit");
    expect(fromCodexLine({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm test"] }) } })[0].tool_input).toEqual({ command: "npm test" });
    expect(fromCodexLine({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Update File: src/x.ts\n" } })[0].tool_input).toEqual({ file_path: "src/x.ts" });

    const r = repo();
    expect(fromClineMessage({ type: "say", say: "task", text: "add dark mode" }, r)![0].hook_event_name).toBe("UserPromptSubmit");
    expect(fromClineMessage({ type: "say", say: "tool", text: JSON.stringify({ tool: "editedExistingFile", path: path.join(r, "src/theme.ts") }) }, r)![0].tool_input).toEqual({ file_path: path.join(r, "src/theme.ts") });
    // An edit in another project means the task isn't ours.
    expect(fromClineMessage({ type: "say", say: "tool", text: JSON.stringify({ tool: "editedExistingFile", path: "/elsewhere/x.ts" }) }, r)).toBeNull();
    expect(fromClineMessage({ type: "say", say: "tool", text: JSON.stringify({ tool: "readFile", path: "src/a.ts" }) }, r)).toEqual([]);
  });

  it("their transcripts are followed live, for this project only, without backfilling history", () => {
    const r = repo();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-tx-"));
    const codexDir = path.join(home, "codex");
    const storage = path.join(home, "storage");
    fs.mkdirSync(codexDir, { recursive: true });
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    // A session already running before the daemon: its past isn't replayed.
    const old = path.join(codexDir, "rollout-2026-10-12T10-00-00-aaaa.jsonl");
    fs.writeFileSync(old, line({ type: "session_meta", payload: { cwd: r, originator: "codex_cli_rs" } }) + line({ type: "event_msg", payload: { type: "user_message", message: "old prompt" } }));
    fs.utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // Another project's session is ignored; AgentBrain's own `codex exec` runs too.
    const other = path.join(codexDir, "rollout-2026-10-12T10-00-01-bbbb.jsonl");
    fs.writeFileSync(other, line({ type: "session_meta", payload: { cwd: "/elsewhere", originator: "codex_cli_rs" } }));
    const task = path.join(storage, "saoudrizwan.claude-dev", "tasks", "171");
    fs.mkdirSync(task, { recursive: true });

    const follow = watchTranscripts(r, { intervalMs: 60_000, scanMs: 0, codexDirs: [codexDir], storage: [storage] });
    try {
      fs.appendFileSync(old, line({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm run lint"] }) } }));
      fs.appendFileSync(other, line({ type: "event_msg", payload: { type: "user_message", message: "not ours" } }));
      fs.writeFileSync(path.join(task, "ui_messages.json"), JSON.stringify([
        { ts: 1, type: "say", say: "task", text: "add dark mode" },
        { ts: 2, type: "say", say: "text", text: "I'll add a theme token for the background first." },
        { ts: 3, type: "say", say: "tool", text: JSON.stringify({ tool: "editedExistingFile", path: path.join(r, "src/theme.ts") }) },
      ]));
      follow.tick();
      follow.tick(); // nothing new: nothing recorded twice
    } finally {
      follow();
    }
    const activity = readActivity(r);
    expect(activity.some((e) => /old prompt|not ours/.test(e.text))).toBe(false);
    expect(activity.filter((e) => e.agent === "codex").map((e) => e.kind)).toEqual(["command"]);
    expect(activity.filter((e) => e.agent === "cline").map((e) => e.kind)).toEqual(["session", "prompt", "thought", "edit"]);
    expect(activity.find((e) => e.agent === "cline" && e.kind === "edit")?.files).toEqual(["src/theme.ts"]);
  });
});
