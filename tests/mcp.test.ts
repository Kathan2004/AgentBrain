import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { connectAgents } from "../src/core/connect.js";
import { AgentBrainMcpServer, agentIdFromClient } from "../src/mcp/server.js";
import { CLI, ab, activeTask, readJson, tempRepo } from "./helpers.js";

/** In-process MCP client over a pair of streams. */
function connect(options: { root?: string; roots?: string[] } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new AgentBrainMcpServer({ root: options.root, input, output, log: () => {} });
  const done = server.start();
  const waiting = new Map<number, (m: any) => void>();
  const notifications: string[] = [];
  let buffer = "";
  let id = 0;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (message.method === "roots/list") {
        const roots = (options.roots ?? []).map((dir) => ({ uri: pathToFileURL(dir).href }));
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { roots } })}\n`);
      } else if (message.id === undefined) {
        notifications.push(message.method);
      } else {
        waiting.get(message.id)?.(message);
      }
    }
  });
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const notify = (method: string) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const call = async (name: string, args: unknown = {}) => {
    const response = await request("tools/call", { name, arguments: args });
    return { text: response.result.content[0].text as string, isError: Boolean(response.result.isError) };
  };
  const initialize = (clientName: string, roots = false) =>
    request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: roots ? { roots: {} } : {},
      clientInfo: { name: clientName, version: "1" },
    });
  const close = async () => {
    input.end();
    await done;
  };
  return { request, notify, call, initialize, close, notifications };
}

function project() {
  const repo = tempRepo("agentbrain-mcp-");
  ab(repo, ["init"]);
  ab(repo, ["task", "create", "Implement OAuth login"]);
  ab(repo, ["task", "update", "--agent", "codex", "--done", "1", "--done", "OAuth callback",
    "--todo", "Refresh-token rotation", "--decision", "httpOnly cookies", "--next", "Implement refresh-token rotation"]);
  ab(repo, ["handoff", "--reason", "usage limit"]);
  return repo;
}

describe("MCP server", () => {
  it("puts the live task state in the instructions of a brand-new session", async () => {
    const repo = project();
    const client = connect({ root: repo });
    const init = await client.initialize("Visual Studio Code");

    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("agentbrain");
    const instructions: string = init.result.instructions;
    expect(instructions).toContain("call agentbrain_brief");
    expect(instructions).toContain("You are continuing AgentBrain task");
    expect(instructions).toContain("as if you had done it yourself");
    expect(instructions).toContain("Implement refresh-token rotation");
    expect(instructions).toContain("Last agent: codex");
    expect(instructions).toContain("Stop reason: usage limit");
    await client.close();
  });

  it("lets a new agent continue and record progress, then hands off on disconnect", async () => {
    const repo = project();
    const client = connect({ root: repo });
    await client.initialize("claude-code");
    client.notify("notifications/initialized");

    const tools = await client.request("tools/list");
    expect(tools.result.tools.map((t: any) => t.name)).toEqual([
      "agentbrain_brief",
      "agentbrain_update",
      "agentbrain_handoff",
      "agentbrain_checkpoint",
      "agentbrain_create_task",
      "agentbrain_list_tasks",
    ]);

    const brief = await client.call("agentbrain_brief");
    expect(brief.text).toContain("1. Refresh-token rotation");

    // Reading alone doesn't claim the task.
    expect(activeTask(repo).agent.id).toBe("codex");

    const update = await client.call("agentbrain_update", {
      done: ["1"],
      decisions: "Rotate on every use",
      next: "Write tests",
    });
    expect(update.isError).toBe(false);
    expect(update.text).toContain("Next: Write tests");

    const task = activeTask(repo);
    expect(task).toMatchObject({ status: "running", agent: { id: "claude-code" } });
    expect(task.completed).toContain("Refresh-token rotation");
    expect(task.decisions).toContain("Rotate on every use");

    // The agent is cut off (window closed, crash, usage limit): AgentBrain hands off for it.
    await client.close();
    const after = activeTask(repo);
    expect(after.status).toBe("handoff");
    const cpDir = path.join(repo, ".agentbrain/tasks", after.id, "checkpoints");
    const latest = fs.readdirSync(cpDir).filter((f) => f.endsWith(".json")).sort().at(-1)!;
    expect(readJson(path.join(cpDir, latest)).stopReason).toBe("claude-code: MCP session ended");
  });

  it("does not hand off on disconnect if the agent already finished", async () => {
    const repo = project();
    const client = connect({ root: repo });
    await client.initialize("cursor-vscode");
    await client.call("agentbrain_update", { done: ["1"], status: "review" });
    await client.close();
    expect(activeTask(repo)).toMatchObject({ status: "review", agent: { id: "cursor" } });
  });

  it("finds the project through the client's MCP roots", async () => {
    const repo = project();
    const empty = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "agentbrain-noroot-"));
    const client = connect({ root: empty, roots: [path.join(repo, "missing"), repo] });
    await client.initialize("Visual Studio Code", true);
    client.notify("notifications/initialized");
    // Give the server a moment to ask for roots.
    await new Promise((r) => setTimeout(r, 50));
    expect((await client.call("agentbrain_brief")).text).toContain("Implement OAuth login");
    await client.close();
  });

  it("explains how to start when the workspace has no project", async () => {
    const client = connect({ root: fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "agentbrain-none-")) });
    await client.initialize("claude-code");
    const result = await client.call("agentbrain_brief");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("agentbrain init");
    expect((await client.request("bogus/method")).error.code).toBe(-32601);
    await client.close();
  });

  it("shows the task in progress in the tool list, which every client gives the model", async () => {
    const repo = project();
    const client = connect({ root: repo });
    await client.initialize("Visual Studio Code");
    const tools = (await client.request("tools/list")).result.tools;
    const brief = tools.find((t: any) => t.name === "agentbrain_brief").description;
    expect(brief).toContain('TASK IN PROGRESS: task-');
    expect(brief).toContain("Implement OAuth login");
    expect(brief).toContain("next action: Implement refresh-token rotation");
    await client.close();
  });

  it("tells connected agents to refresh when another agent changes the task", async () => {
    const repo = project();
    const client = connect({ root: repo });
    await client.initialize("Visual Studio Code");
    client.notify("notifications/initialized");
    await new Promise((r) => setTimeout(r, 100));
    expect(client.notifications).toEqual([]);

    // Some other agent records progress through the CLI.
    ab(repo, ["task", "update", "--agent", "cursor", "--next", "Write the rotation tests"]);
    for (let i = 0; i < 40 && !client.notifications.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(client.notifications).toEqual(["notifications/tools/list_changed"]);
    const tools = (await client.request("tools/list")).result.tools;
    expect(tools[0].description).toContain("next action: Write the rotation tests");
    expect(tools[0].description).toContain("last worked on by cursor");
    await client.close();
  });

  it("redirects a brief request for a finished task to the task in progress", async () => {
    const repo = project();
    const finished = activeTask(repo).id;
    ab(repo, ["task", "update", "--status", "done"]);
    ab(repo, ["task", "create", "Add logout"]);
    const client = connect({ root: repo });
    await client.initialize("Visual Studio Code");
    const result = await client.call("agentbrain_brief", { task_id: finished });
    expect(result.text).toContain(`Task ${finished} is already done`);
    expect(result.text).toContain("Add logout");
    await client.close();
  });

  it("won't start a new task for 'continue' while one is waiting; returns its brief", async () => {
    const repo = project();
    const client = connect({ root: repo });
    await client.initialize("Visual Studio Code");
    const attempt = await client.call("agentbrain_create_task", { objective: "Continue project work" });
    expect(attempt.text).toContain("Not created");
    expect(attempt.text).toContain("Implement refresh-token rotation");
    expect(activeTask(repo).objective).toBe("Implement OAuth login");
    await client.close();
  });

  it("creates tasks when confirmed and lists them", async () => {
    const repo = project();
    const client = connect({ root: repo });
    await client.initialize("gemini-cli-mcp-client");
    const created = await client.call("agentbrain_create_task", { objective: "Add logout", confirm_new: true });
    expect(created.text).toContain("assigned it to gemini");
    expect((await client.call("agentbrain_list_tasks")).text).toMatch(/\* task-\S+\trunning\tAdd logout/);
    await client.close();
  });

  it("maps client names to agent ids", () => {
    expect(agentIdFromClient("claude-code")).toBe("claude-code");
    expect(agentIdFromClient("Visual Studio Code")).toBe("vscode");
    expect(agentIdFromClient("cursor-vscode")).toBe("cursor");
    expect(agentIdFromClient("codex-mcp-client")).toBe("codex");
    expect(agentIdFromClient("Some New Agent")).toBe("some-new-agent");
  });

  it("works as a real stdio process (agentbrain mcp)", async () => {
    const repo = project();
    const child = spawn("node", [CLI, "mcp", "--root", repo], { stdio: ["pipe", "pipe", "pipe"] });
    const lines: any[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agentbrain_update", arguments: { todo: ["Write tests"] } } })}\n`);
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
    expect(lines[0].result.instructions).toContain("Implement refresh-token rotation");
    expect(lines[1].result.content[0].text).toContain("Recorded.");
    expect(activeTask(repo)).toMatchObject({ status: "handoff", agent: { id: "codex" } });
  });
});

describe("connectAgents", () => {
  it("adds the server to each agent config without touching other settings", () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "agentbrain-connect-"));
    fs.mkdirSync(path.join(dir, ".vscode"));
    fs.writeFileSync(path.join(dir, ".vscode/mcp.json"), JSON.stringify({ servers: { other: { command: "x" } } }));
    fs.mkdirSync(path.join(dir, ".gemini"));
    fs.writeFileSync(path.join(dir, ".gemini/settings.json"), "{ // comment\n}");

    const results = connectAgents(dir, "agentbrain", ["mcp"]);
    expect(results.map((r) => [r.file, r.action])).toEqual([
      [".mcp.json", "created"],
      [".vscode/mcp.json", "updated"],
      [".cursor/mcp.json", "created"],
      [".gemini/settings.json", "skipped"],
    ]);
    const vscode = readJson(path.join(dir, ".vscode/mcp.json"));
    expect(vscode.servers.other).toEqual({ command: "x" });
    expect(vscode.servers.agentbrain).toEqual({
      type: "stdio",
      command: "agentbrain",
      args: ["mcp", "--root", "${workspaceFolder}"],
    });
    expect(readJson(path.join(dir, ".mcp.json")).mcpServers.agentbrain.command).toBe("agentbrain");
    expect(connectAgents(dir, "agentbrain", ["mcp"], ["claude"])[0].action).toBe("unchanged");
  });
});
