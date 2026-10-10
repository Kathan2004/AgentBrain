import { describe, expect, it } from "vitest";
import { PAGE } from "../src/ui/page.js";

describe("control room page", () => {
  it("ships scripts that parse (one broken quote blanks the whole page)", () => {
    const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  });
});
