import fs from "node:fs";

/**
 * What an agent says it is about to do and why ("I'll make closeTask remove the
 * worktree, since doctor reports nine left behind"): the plain-English reason
 * behind the edits and commands in the feed.
 *
 * A capable agent narrates its intent in a sentence; a local model dumps its
 * whole chain of thought ("Okay, let me try to figure out how to approach
 * this. First, I need to…"). We trim that filler and keep a readable gist, cut
 * at a sentence boundary rather than mid-word, so the feed stays plain English.
 */

const MAX = 320;
const HARD = 2000;
/** Rambling lead-ins a thinking model opens with, which say nothing about the work. */
const FILLER = /^(?:[\s,;:.—-]*(?:okay|ok|alright|right|hmm|uh|so|well|now|let(?:'s| me| us)[^.!?]*[.!?]|i (?:need to|should|will|'ll|'m going to|am going to|want to) (?:think|figure|start|look|see|understand|approach|process|check|try|work)[^.!?]*[.!?]))+/i;

export function thoughtFrom(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const pick = (type: string, field: string) =>
    content.filter((p: any) => p?.type === type && typeof p[field] === "string").map((p: any) => p[field] as string).join(" ");
  const raw = pick("text", "text") || pick("thinking", "thinking");
  let text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<\/?think>/gi, " ")
    .replace(/[*_#>`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Drop the filler preamble, but only if there's real content left after it.
  const trimmed = text.replace(FILLER, "").trim();
  if (trimmed.length >= 12) text = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  if (text.length < 12) return null;
  if (text.length <= MAX) return text;
  // Keep whole sentences up to the limit; if the first sentence alone is huge, cut on a word.
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
  let gist = "";
  for (const s of sentences) {
    if (gist && (gist + s).length > MAX) break;
    gist += s;
  }
  gist = gist.trim();
  if (gist.length < 40) gist = text.slice(0, Math.min(HARD, text.lastIndexOf(" ", MAX) > 40 ? text.lastIndexOf(" ", MAX) : MAX));
  return gist.length < text.length ? `${gist.replace(/[.!?]+$/, "")}…` : gist;
}

/** The latest narration in a Claude Code transcript (JSONL), reading only its tail. */
export function latestThought(transcriptPath: string | undefined, tailBytes = 256 * 1024): string | null {
  if (!transcriptPath) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= (start ? 1 : 0); i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const said = thoughtFrom(entry?.message?.content);
        if (said) return said;
      } catch {
        // partial or non-JSON line in the tail; skip it
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}
