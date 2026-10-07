import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findOnPath } from "../adapters/process.js";
import { CONNECT_TARGETS } from "./connect.js";
import { findRoot } from "./paths.js";
import { RULES_TARGETS } from "./rules.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function hookFile(cwd: string): string | null {
  try {
    const hooks = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.isAbsolute(hooks) ? hooks : path.resolve(cwd, hooks);
  } catch {
    return null;
  }
}

function configHasServer(root: string, file: string, key: "mcpServers" | "servers"): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as Record<string, any>;
    return Boolean(config[key]?.agentbrain);
  } catch {
    return false;
  }
}

export function runDoctor(cwd: string): DoctorCheck[] {
  const repo = gitRoot(cwd);
  const root = findRoot(cwd);
  const checks: DoctorCheck[] = [
    process.versions.node.split(".").map(Number)[0] >= 20
      ? { name: "Node.js", ok: true, detail: `v${process.versions.node}` }
      : { name: "Node.js", ok: false, detail: `v${process.versions.node} (requires >= 20)`, fix: "Install Node.js 20 or newer" },
  ];

  const cli = findOnPath("agentbrain");
  checks.push(
    cli
      ? { name: "agentbrain on PATH", ok: true, detail: cli }
      : { name: "agentbrain on PATH", ok: false, detail: "not found (GUI agents need this)", fix: "Run npm link, or link dist/cli/main.js into a directory on PATH" },
  );
  checks.push(
    repo
      ? { name: "Git repository", ok: true, detail: repo }
      : { name: "Git repository", ok: false, detail: "not inside a Git repository", fix: "Run git init" },
  );
  checks.push(
    root
      ? { name: "AgentBrain initialized", ok: true, detail: path.join(root, ".agentbrain") }
      : { name: "AgentBrain initialized", ok: false, detail: "no .agentbrain/project.json found", fix: "Run agentbrain init" },
  );

  const hook = repo ? hookFile(cwd) : null;
  const postCommit = hook && path.join(hook, "post-commit");
  const hookContent = postCommit && fs.existsSync(postCommit) ? fs.readFileSync(postCommit, "utf8") : "";
  checks.push(
    postCommit && hookContent.includes("# agentbrain:start")
      ? { name: "Post-commit hook", ok: true, detail: postCommit }
      : { name: "Post-commit hook", ok: false, detail: "AgentBrain marker not found", fix: "Run agentbrain hooks install" },
  );

  // A config pointing at a server that doesn't start is the failure agents can't report.
  if (cli && root) {
    const handshake = spawnSync(cli, ["mcp", "--root", root], {
      input: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentbrain-doctor", version: "1" } },
      })}\n`,
      encoding: "utf8",
      timeout: 10_000,
    });
    let serverName: string | undefined;
    try {
      serverName = JSON.parse(handshake.stdout.split("\n")[0]).result?.serverInfo?.name;
    } catch {
      // reported below
    }
    checks.push(
      serverName === "agentbrain"
        ? { name: "MCP server", ok: true, detail: "starts and answers initialize" }
        : {
            name: "MCP server",
            ok: false,
            detail: `\`agentbrain mcp\` did not answer (${handshake.error?.message ?? handshake.stderr.trim().split("\n")[0] ?? "no output"})`,
            fix: "Run npm run build in the AgentBrain repo, then agentbrain doctor again",
          },
    );
  }

  const configRoot = root ?? repo ?? cwd;
  for (const target of CONNECT_TARGETS) {
    const file = path.join(configRoot, target.file);
    checks.push({
      name: `${target.agent} MCP`,
      ok: configHasServer(configRoot, target.file, target.key),
      detail: fs.existsSync(file) ? target.file : `${target.file} is missing`,
      fix: configHasServer(configRoot, target.file, target.key) ? undefined : "Run agentbrain connect",
    });
  }
  for (const target of RULES_TARGETS) {
    const file = path.join(configRoot, target.file);
    let content = "";
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      // Report the missing instruction file below.
    }
    const ok = content.toLowerCase().includes("agentbrain");
    checks.push({
      name: `${target.file} rules`,
      ok,
      detail: ok ? target.file : `${target.file} is missing or has no AgentBrain instructions`,
      fix: ok ? undefined : "Run agentbrain rules",
    });
  }
  return checks;
}