import { describe, expect, it } from "vitest";
import { isPickable, PAGE } from "../src/ui/page.js";

describe("control room page", () => {
  it("ships scripts that parse (one broken quote blanks the whole page)", () => {
    const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  });

  it("hides tier ids (a dotted platform.tier) from agent pickers, keeping the bare platform", () => {
    expect(isPickable("claude-code")).toBe(true);
    expect(isPickable("codex")).toBe(true);
    expect(isPickable("claude-code.sonnet")).toBe(false);
    expect(isPickable("claude-code.haiku")).toBe(false);
  });

  it("shows a retry button instead of a blank page when the initial snapshot fails to load", () => {
    expect(PAGE).toContain("retrySnapshot");
    expect(PAGE).toContain("Retry");
  });

  it("makes diff file headers keyboard-focusable like the task rows", () => {
    expect(PAGE).toContain(`data-file="'+esc(f.path)+'" role="button" tabindex="0"`);
  });
});

describe("the live rail and narrow layouts", () => {
  it("lists recent work one entry per task, so one busy task can't fill it", () => {
    expect(PAGE).toContain("byTask[e.task]");
    expect(PAGE).toContain("S.tasks.slice().sort(");
  });

  it("keeps the nav in one row and the task tabs on one line when narrow", () => {
    expect(PAGE).toContain(".navs{display:flex");
    expect(PAGE).toContain(".prtabs>*{white-space:nowrap");
  });
});
