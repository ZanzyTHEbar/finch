import { defineConfig } from "drizzle-kit";

// Required by `drizzle-kit migrate`; generate ignores it.
const databaseUrl = process.env["DATABASE_URL"] ?? "file:./data/finch.db";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: databaseUrl },
});
