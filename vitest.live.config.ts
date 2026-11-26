import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/live/**/*.live.test.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
