import { describe, expect, it } from "vitest";
import { compilePatterns, redact } from "../src/core/redact.js";

describe("redact", () => {
  it.each([
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwx", "key [REDACTED]"],
    ["aws AKIAABCDEFGHIJKLMNOP done", "aws [REDACTED] done"],
    ["gh ghp_abcdefghijklmnopqrstuvwxyz0123456789", "gh [REDACTED]"],
    ["set DB_PASSWORD=hunter2hunter2 in .env", "set DB_PASSWORD=[REDACTED] in .env"],
    ['api_key: "abcdef123456"', "api_key: [REDACTED]"],
    ["postgres://admin:s3cret@db:5432/app", "postgres://[REDACTED]@db:5432/app"],
    ["-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", "[REDACTED]"],
  ])("redacts %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("leaves ordinary text alone", () => {
    const text = "Use JWT with refresh-token rotation; token expiry is 15m";
    expect(redact(text)).toBe(text);
  });

  it("applies project patterns", () => {
    expect(redact("id INTERNAL-1234 ok", compilePatterns(["INTERNAL-\\d+"]))).toBe("id [REDACTED] ok");
  });
});
