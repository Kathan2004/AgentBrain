import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFS, connectConnector, detectConnectors, disconnectConnector } from "../src/core/connectors.js";
import { initStore } from "../src/core/store.js";
import { tempRepo } from "./helpers.js";

describe("connectors", () => {
  it("knows every tool's kind, capability and how it connects", () => {
    const ids = DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["claude-code", "codex", "vscode", "cursor", "copilot", "cline", "kilo", "claude-app", "chatgpt-app"]) expect(ids).toContain(id);
    expect(DEFS.find((d) => d.id === "chatgpt-app")!.capability).toBe("none");
    expect(DEFS.find((d) => d.id === "claude-app")!.capability).toBe("review");
    // Every connectable tool either has a config file AgentBrain writes, or plain manual steps.
    for (const d of DEFS.filter((d) => d.capability !== "none")) expect(Boolean(d.mcp || d.manual)).toBe(true);
  });

  it("connects project-level tools by adding only AgentBrain's entry, and disconnects cleanly", () => {
    const repo = tempRepo("agentbrain-conn-");
    initStore(repo);
    fs.mkdirSync(path.join(repo, ".roo"));
    fs.writeFileSync(path.join(repo, ".roo/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect(connectConnector(repo, "roo", "agentbrain", ["mcp"]).action).toBe("updated");
    expect(connectConnector(repo, "roo", "agentbrain", ["mcp"]).action).toBe("unchanged");
    const roo = JSON.parse(fs.readFileSync(path.join(repo, ".roo/mcp.json"), "utf8"));
    expect(roo.mcpServers).toEqual({ other: { command: "x" }, agentbrain: { command: "agentbrain", args: ["mcp"] } });

    connectConnector(repo, "vscode", "agentbrain", ["mcp"]);
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".vscode/mcp.json"), "utf8")).servers.agentbrain.args).toContain("${workspaceFolder}");
    connectConnector(repo, "opencode", "agentbrain", ["mcp"]);
    expect(JSON.parse(fs.readFileSync(path.join(repo, "opencode.json"), "utf8")).mcp.agentbrain).toEqual({ type: "local", command: ["agentbrain", "mcp"], enabled: true });
    connectConnector(repo, "continue", "agentbrain", ["mcp"]);
    expect(fs.readFileSync(path.join(repo, ".continue/mcpServers/agentbrain.yaml"), "utf8")).toContain("name: agentbrain");

    expect(disconnectConnector(repo, "roo")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".roo/mcp.json"), "utf8")).mcpServers).toEqual({ other: { command: "x" } });
    expect(disconnectConnector(repo, "roo")).toBe(false);
  });

  it("refuses tools that can't be connected, with the reason or the manual steps", () => {
    const repo = tempRepo("agentbrain-conn-");
    initStore(repo);
    expect(() => connectConnector(repo, "chatgpt-app", "agentbrain", ["mcp"])).toThrow(/remote MCP/);
    expect(() => connectConnector(repo, "zed", "agentbrain", ["mcp"])).toThrow(/Add Custom Server/);
    expect(() => connectConnector(repo, "nope", "agentbrain", ["mcp"])).toThrow(/Unknown connector/);
  });

  it("lists every known tool with --all, installed or not", () => {
    const repo = tempRepo("agentbrain-conn-");
    initStore(repo);
    const all = detectConnectors(repo, { all: true });
    expect(all).toHaveLength(DEFS.length);
    expect(all.every((c) => typeof c.installed === "boolean")).toBe(true);
  });
});
