import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    server: {
      deps: {
        // bun:sqlite is provided by the Bun runtime; leave it alone so the
        // native import survives transformation (tests run via `bun run test`).
        external: [/^bun:/],
      },
    },
  },
});
