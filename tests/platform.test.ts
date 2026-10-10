import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findOnPath, findTool, isWindows, selfCommand, spawnSyncPortable, userBinDirs } from "../src/core/platform.js";

describe("platform helpers", () => {
  it("finds executables on a PATH (with Windows extensions on Windows)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-path-"));
    const name = isWindows ? "fake-agent.cmd" : "fake-agent";
    fs.writeFileSync(path.join(dir, name), isWindows ? "@echo off\r\necho %*\r\n" : "#!/bin/sh\necho \"$@\"\n");
    fs.chmodSync(path.join(dir, name), 0o755);
    expect(findOnPath("fake-agent", dir)).toBe(path.join(dir, name));
    expect(findOnPath("missing-agent", dir)).toBeNull();
  });

  it("passes awkward arguments through intact, even to Windows .cmd shims", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-args-"));
    const script = path.join(dir, isWindows ? "echoargs.cmd" : "echoargs");
    if (isWindows) fs.writeFileSync(script, `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
    else fs.writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@"\n`);
    fs.chmodSync(script, 0o755);
    const args = ["plain", "with space", 'quote " inside', "a&b|c", "100%"];
    const result = spawnSyncPortable(script, args, { encoding: "utf8" });
    expect(JSON.parse(String(result.stdout).trim())).toEqual(args);
  });

  it("findTool finds an executable placed in a temp dir passed via PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbrain-findtool-"));
    const name = isWindows ? "my-tool.cmd" : "my-tool";
    fs.writeFileSync(path.join(dir, name), isWindows ? "@echo off\r\n" : "#!/bin/sh\n");
    fs.chmodSync(path.join(dir, name), 0o755);
    const origPath = process.env.PATH;
    try {
      process.env.PATH = dir + path.delimiter + (origPath ?? "");
      expect(findTool("my-tool")).toBe(path.join(dir, name));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("findTool returns null for a missing command", () => {
    expect(findTool("definitely-does-not-exist-" + Date.now())).toBeNull();
  });

  it("userBinDirs includes ~/.local/bin", () => {
    const dirs = userBinDirs();
    expect(dirs).toContain(path.join(os.homedir(), ".local", "bin"));
  });

  it("starts itself with Node and the script path on every OS", () => {
    const self = selfCommand(path.resolve("package.json"));
    expect(self.command).toBe(process.execPath);
    expect(self.args[0]).toBe(fs.realpathSync(path.resolve("package.json")));
  });
});
