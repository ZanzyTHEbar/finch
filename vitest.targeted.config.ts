import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/mcp/**/*.test.ts", "tests/reconciliation/**/*.test.ts", "tests/enablebanking/**/*.test.ts"],
    testTimeout: 60000,
  },
})
