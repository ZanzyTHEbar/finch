import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/client/**/*.test.ts", "tests/mcp/**/*.test.ts", "tests/connect/**/*.test.ts", "tests/enablebanking/**/*.test.ts"],
    testTimeout: 60000,
  },
})
