#!/usr/bin/env node
// A stand-in ACP agent for tests. Speaks ACP on stdio like claude-code-acp or
// `gemini --experimental-acp`, and uses the MCP server it is given the way a
// real agent would. Behaviour is chosen with FAKE_MODE: work (default), hang, crash.
import { spawn } from "node:child_process";
import fs from "node:fs";

const mode = process.env.FAKE_MODE ?? "work";
const report = { prompts: [], mcp: {}, fs: {}, permissions: {} };
const save = () => process.env.FAKE_REPORT && fs.writeFileSync(process.env.FAKE_REPORT, JSON.stringify(report, null, 2));

let nextId = 1000;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const ask = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});
const say = (sessionId, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

// --- MCP client for the server AgentBrain hands us in session/new
let mcp, mcpBuf = "", mcpId = 1;
const mcpWaiting = new Map();
function startMcp(server) {
  mcp = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] });
  mcp.stdout.setEncoding("utf8");
  mcp.stdout.on("data", (chunk) => {
    mcpBuf += chunk;
    let i;
    while ((i = mcpBuf.indexOf("\n")) !== -1) {
      const msg = JSON.parse(mcpBuf.slice(0, i));
      mcpBuf = mcpBuf.slice(i + 1);
      if (msg.id !== undefined && mcpWaiting.has(msg.id)) { mcpWaiting.get(msg.id)(msg); mcpWaiting.delete(msg.id); }
    }
  });
}
const mcpCall = (method, params) => new Promise((resolve) => {
  const id = mcpId++;
  mcpWaiting.set(id, resolve);
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const tool = async (name, args = {}) => (await mcpCall("tools/call", { name, arguments: args })).result.content[0].text;

async function work(sessionId, promptText) {
  report.prompts.push(promptText.slice(0, 2000));
  if (mode === "crash") process.exit(2);
  if (mode === "hang") return new Promise(() => {});
  if (report.prompts.length > 1) { save(); return "end_turn"; } // follow-up turns: nothing more to do

  say(sessionId, "Reading the AgentBrain brief");
  report.mcp.brief = await tool("agentbrain_brief");

  report.fs.read = (await ask("fs/read_text_file", { sessionId, path: "README.md" })).result?.content;
  report.fs.write = await ask("fs/write_text_file", { sessionId, path: "feature.ts", content: "export const feature = 1;\n" });
  report.fs.escape = await ask("fs/write_text_file", { sessionId, path: "../escaped.txt", content: "no" });

  const options = [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ];
  report.permissions.execute = (await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "t1", title: "rm -rf build", kind: "execute" }, options })).result;
  report.permissions.edit = (await ask("session/request_permission", { sessionId, toolCall: { toolCallId: "t2", title: "Edit feature.ts", kind: "edit" }, options })).result;

  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit feature.ts", kind: "edit", status: "completed" } } });
  report.mcp.update = await tool("agentbrain_update", {
    done: ["1"],
    decisions: ["Exported a constant to keep the feature minimal"],
    status: process.env.FAKE_STATUS ?? "review",
    next: "Review feature.ts",
  });
  save();
  return "end_turn";
}

let buf = "";
let promptPending = null;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === undefined) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); continue; }
    if (msg.method === "initialize") {
      report.initialize = msg.params;
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
    } else if (msg.method === "session/new") {
      report.session = msg.params;
      startMcp(msg.params.mcpServers[0]);
      const init = await mcpCall("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp-agent", version: "1" } });
      report.mcp.instructions = init.result.instructions;
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } });
    } else if (msg.method === "session/prompt") {
      promptPending = msg.id;
      const stopReason = await work(msg.params.sessionId, msg.params.prompt[0].text);
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason } });
      promptPending = null;
    } else if (msg.method === "session/cancel") {
      report.cancelled = true; save();
      if (promptPending !== null) send({ jsonrpc: "2.0", id: promptPending, result: { stopReason: "cancelled" } });
    }
  }
});
process.stdin.on("end", () => { mcp?.stdin.end(); setTimeout(() => process.exit(0), 200); });
