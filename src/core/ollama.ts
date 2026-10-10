import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTool, spawnSyncPortable } from "./platform.js";

/**
 * A local model as a worker. Ollama serves Anthropic's API, so AgentBrain runs
 * the same Claude Code harness against it: the same tools, the same AgentBrain
 * MCP server, the same task packet and vault. Only the model changes, and it
 * has no quota, so work can always continue when the hosted agents are out.
 */

export const OLLAMA_URL = process.env.OLLAMA_HOST
  ? (/^https?:\/\//.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`)
  : "http://127.0.0.1:11434";

/** The model AgentBrain sets up: Qwen 3 8B with room for Claude Code's long prompt. */
export const DEFAULT_LOCAL_MODEL = "agentbrain-qwen3";
export const BASE_LOCAL_MODEL = "qwen3:8b";
export const LOCAL_CONTEXT = 32768;

export function ollamaBinary(): string | null {
  if (process.env.AGENTBRAIN_ONLY_PATH) return findTool("ollama");
  const app = "/Applications/Ollama.app/Contents/Resources/ollama";
  return findTool("ollama") ?? (fs.existsSync(app) ? app : null);
}

function configFile(home = os.homedir()): string {
  return path.join(home, ".agentbrain", "ollama.json");
}

let listCache: { at: number; models: string[] | null } | undefined;

/** Models Ollama has pulled, or null when Ollama isn't running (cached for a minute). */
export function ollamaModels(): string[] | null {
  if (listCache && Date.now() - listCache.at < 60_000) return listCache.models;
  const bin = ollamaBinary();
  let models: string[] | null = null;
  if (bin) {
    const result = spawnSyncPortable(bin, ["list"], { encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) {
      models = String(result.stdout ?? "").split("\n").slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
    }
  }
  listCache = { at: Date.now(), models };
  return models;
}

export function clearOllamaCache(): void {
  listCache = undefined;
}

/** The chosen local model: set with `agentbrain local <model>`, else AgentBrain's own, else the first pulled. */
export function localModel(home = os.homedir()): string | null {
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(home), "utf8")) as { model?: string };
    if (saved.model) return saved.model;
  } catch { /* not set */ }
  const models = ollamaModels() ?? [];
  const bare = (m: string) => m.replace(/:latest$/, "");
  return models.map(bare).find((m) => m === DEFAULT_LOCAL_MODEL) ?? (models[0] ? bare(models[0]) : null);
}

export function setLocalModel(model: string, home = os.homedir()): void {
  fs.mkdirSync(path.dirname(configFile(home)), { recursive: true });
  fs.writeFileSync(configFile(home), `${JSON.stringify({ model }, null, 2)}\n`);
}

/** Environment that points Claude Code at Ollama instead of Anthropic. */
export function ollamaEnv(model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: OLLAMA_URL,
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/**
 * Pulls the base model and creates AgentBrain's variant with a context window
 * big enough for an agent (Ollama's default is too small for Claude Code's prompt).
 */
export function setupLocalModel(base = BASE_LOCAL_MODEL, name = DEFAULT_LOCAL_MODEL, log: (s: string) => void = () => {}): string {
  const bin = ollamaBinary();
  if (!bin) throw new Error("Ollama is not installed: get it from https://ollama.com/download");
  if (ollamaModels() === null) throw new Error("Ollama isn't running: open the Ollama app.");
  log(`Pulling ${base}…`);
  const pull = spawnSyncPortable(bin, ["pull", base], { stdio: "inherit", timeout: 3_600_000 });
  if (pull.status !== 0) throw new Error(`ollama pull ${base} failed`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-ollama-"));
  const modelfile = path.join(dir, "Modelfile");
  fs.writeFileSync(modelfile, `FROM ${base}\nPARAMETER num_ctx ${LOCAL_CONTEXT}\n`);
  log(`Creating ${name} (${LOCAL_CONTEXT} token context)…`);
  const create = spawnSyncPortable(bin, ["create", name, "-f", modelfile], { encoding: "utf8", timeout: 600_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  if (create.status !== 0) throw new Error(`ollama create failed: ${String(create.stderr ?? "").trim()}`);
  setLocalModel(name);
  clearOllamaCache();
  return name;
}
