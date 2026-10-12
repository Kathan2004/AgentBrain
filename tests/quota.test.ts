import { describe, expect, it } from "vitest";
import { clearOutOfQuota, markOutOfQuota, quotaReason } from "../src/core/limits.js";
import { initStore } from "../src/core/store.js";
import { tempRepo } from "./helpers.js";

describe("agents marked out of quota", () => {
  it("stay out until the date passes, or until cleared", () => {
    const repo = tempRepo("agentbrain-quota-");
    initStore(repo);
    expect(quotaReason(repo, "vscode")).toBeUndefined();

    markOutOfQuota(repo, "vscode", new Date(Date.now() + 3_600_000));
    expect(quotaReason(repo, "vscode")).toMatch(/out of quota until/);
    expect(quotaReason(repo, "vscode", new Date(Date.now() + 2 * 3_600_000))).toBeUndefined();

    markOutOfQuota(repo, "codex");
    expect(quotaReason(repo, "codex", new Date(Date.now() + 365 * 24 * 3_600_000))).toMatch(/--clear/);
    clearOutOfQuota(repo, "codex");
    expect(quotaReason(repo, "codex")).toBeUndefined();
  });

  it("rejects a date that doesn't parse", () => {
    const repo = tempRepo("agentbrain-quota-");
    initStore(repo);
    expect(() => markOutOfQuota(repo, "vscode", new Date("not a date"))).toThrow(/isn't valid/);
  });
});
