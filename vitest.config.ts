import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CLI tests spawn node and git repeatedly.
    testTimeout: 30_000,
  },
});
