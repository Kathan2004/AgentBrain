import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kindFromTitle } from "../src/adapters/acp.js";
import { permissionMode, setPermissionMode } from "../src/core/permissions.js";
import { createTask } from "../src/core/actions.js";
import { initStore } from "../src/core/store.js";
import { addWorktree } from "../src/core/worktree.js";
import { tempRepo } from "./helpers.js";

describe("permissions", () => {
  it("asks by default, and `all` turns on Copilot auto-approve for this workspace only", () => {
    const repo = tempRepo("agentbrain-perm-");
    initStore(repo);
    expect(permissionMode(repo)).toBe("ask");
    fs.mkdirSync(path.join(repo, ".vscode"));
    fs.writeFileSync(path.join(repo, ".vscode", "settings.json"), JSON.stringify({ "editor.tabSize": 2 }));

    const on = setPermissionMode(repo, "all");
    expect(permissionMode(repo)).toBe("all");
    const settings = JSON.parse(fs.readFileSync(on.vscode!, "utf8"));
    expect(settings).toMatchObject({ "editor.tabSize": 2, "chat.tools.global.autoApprove": true, "chat.tools.autoApprove": true });

    setPermissionMode(repo, "ask");
    expect(permissionMode(repo)).toBe("ask");
    expect(JSON.parse(fs.readFileSync(on.vscode!, "utf8"))).toEqual({ "editor.tabSize": 2 });
  });

  it("puts auto-approve in task worktrees too, since Copilot is often opened there, and keeps it out of Git", () => {
    const repo = tempRepo("agentbrain-perm-");
    initStore(repo);
    const before = addWorktree(repo, createTask(repo, "Old task").id);
    setPermissionMode(repo, "all");
    const after = addWorktree(repo, createTask(repo, "New task").id);
    for (const t of [before, after]) {
      const settings = JSON.parse(fs.readFileSync(path.join(t.worktree!.path, ".vscode", "settings.json"), "utf8"));
      expect(settings["chat.tools.global.autoApprove"]).toBe(true);
    }
    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toContain(".vscode/settings.json");
  });

  it("leaves a settings file with comments alone", () => {
    const repo = tempRepo("agentbrain-perm-");
    initStore(repo);
    fs.mkdirSync(path.join(repo, ".vscode"));
    const file = path.join(repo, ".vscode", "settings.json");
    fs.writeFileSync(file, '{\n  // mine\n  "editor.tabSize": 2\n}\n');
    const result = setPermissionMode(repo, "all");
    expect(result.warning).toMatch(/comments/);
    expect(fs.readFileSync(file, "utf8")).toContain("// mine");
    expect(permissionMode(repo)).toBe("all");
  });

  it("works out a tool's kind from a permission request's title", () => {
    expect(kindFromTitle("Edit `src/a.ts`")).toBe("edit");
    expect(kindFromTitle("Read File")).toBe("read");
    expect(kindFromTitle("Terminal")).toBe("execute");
    expect(kindFromTitle("Something else")).toBeUndefined();
  });
});
