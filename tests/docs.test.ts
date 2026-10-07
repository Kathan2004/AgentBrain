import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const usageSource = fs.readFileSync(path.resolve("src/cli/main.ts"), "utf8");
const readme = fs.readFileSync(path.resolve("README.md"), "utf8");

function usageCommands(): string[] {
  const commands = new Set<string>();

  for (const line of usageSource.split("\n")) {
    const match = line.match(/^  agentbrain ([a-z-]+)(?: ([a-z-]+))?(?:\s|$)/);
    if (match) commands.add([match[1], match[2]].filter(Boolean).join(" "));
  }

  return [...commands];
}

describe("CLI documentation", () => {
  it("documents every command shown in the CLI usage", () => {
    for (const command of usageCommands()) {
      const pattern = new RegExp(`(?:agentbrain|/)\\s*${command.replace(" ", "\\s+")}\\b`);
      expect(readme).toMatch(pattern);
    }
  });
});