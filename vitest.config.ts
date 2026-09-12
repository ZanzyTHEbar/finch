import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "npm:jose@6.2.12": "jose",
      "npm:@supabase/supabase-js@2.116.0": "@supabase/supabase-js",
    },
  },
  test: {
    environment: "node",
    include: [
      "tests/supabase/**/*.test.ts",
      "tests/lib/**/*.test.ts",
    ],
    testTimeout: 60000,
  },
});
