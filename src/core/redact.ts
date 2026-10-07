/**
 * Secret redaction for everything AgentBrain writes to `.agentbrain/`.
 *
 * Handoffs get pasted into other agents (and often committed), so free-text
 * task fields are scrubbed before they are stored. This is a safety net for
 * accidental pastes, not a guarantee: projects can add their own patterns via
 * `redactPatterns` in `.agentbrain/project.json`.
 */

export const REDACTED = "[REDACTED]";

const BUILTIN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic / OpenAI style keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** `password=hunter22`, `API_KEY: "abc..."` — keep the key name, drop the value. */
const ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi;

/** `https://user:pass@host` */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

export function compilePatterns(patterns: string[] = []): RegExp[] {
  return patterns.map((source) => {
    try {
      return new RegExp(source, "g");
    } catch {
      throw new Error(`Invalid redaction pattern in project.json: ${source}`);
    }
  });
}

export function redact(text: string, extra: RegExp[] = []): string {
  let out = text;
  for (const pattern of [...BUILTIN_PATTERNS, ...extra]) out = out.replace(pattern, REDACTED);
  out = out.replace(ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  return out;
}

export function redactAll(items: string[], extra: RegExp[] = []): string[] {
  return items.map((item) => redact(item, extra));
}
