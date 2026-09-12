import { execFileSync, spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";

const status = execFileSync("bunx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
const environment = Object.fromEntries(
  status
    .split("\n")
    .map((line) => line.match(/^([A-Z0-9_]+)="(.*)"$/))
    .filter((match) => match !== null)
    .map((match) => [match[1], match[2]]),
);

for (const key of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"]) {
  if (typeof environment[key] !== "string" || environment[key] === "") {
    throw new Error(`local Supabase is not ready: missing ${key}`);
  }
}

const functionEnvFile = "/tmp/opencode/finch-functions.env";
const workerToken = "test-worker-token-0123456789abcdef0123456789abcdef";
await writeFile(
  functionEnvFile,
  [
    `FINCH_WORKER_TOKEN=${workerToken}`,
    "FINCH_PUBLIC_APP_ORIGIN=https://app.finch.test",
    "FINCH_BANK_CALLBACK_URL=https://project.finch.test/functions/v1/bank-callback",
    "ENABLEBANKING_BASE_URL=https://api.enablebanking.com",
  ].join("\n"),
);

const waitForAuth = async () => {
  const url = `${environment.API_URL}/auth/v1/admin/users?page=1&per_page=1`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          apikey: environment.SERVICE_ROLE_KEY,
          authorization: `Bearer ${environment.SERVICE_ROLE_KEY}`,
        },
      });
      if (response.ok) return;
    } catch {
      // Auth is still reconnecting after a local database reset.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("local Supabase Auth did not become ready");
};

const functions = spawn("bunx", ["supabase", "functions", "serve", "--no-verify-jwt", "--env-file", functionEnvFile], {
  stdio: "inherit",
});

const waitForFunctions = async () => {
  const url = `${environment.API_URL}/functions/v1/api/workspaces`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 401) return;
    } catch {
      // The runtime is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("local Edge Functions did not become ready");
};

try {
  await waitForAuth();
  await waitForFunctions();
  const testEnvironment = {
    ...process.env,
    FINCH_TEST_SUPABASE_URL: environment.API_URL,
    FINCH_TEST_SUPABASE_ANON_KEY: environment.ANON_KEY,
    FINCH_TEST_SUPABASE_SERVICE_ROLE_KEY: environment.SERVICE_ROLE_KEY,
    FINCH_TEST_WORKER_TOKEN: workerToken,
  };
  for (const testFile of [
    "tests/supabase/auth-rls.test.ts",
    "tests/supabase/connect-ledger-adapter.test.ts",
    "tests/supabase/connect-receipt-adapter.test.ts",
  ]) {
    execFileSync("bun", ["./node_modules/vitest/vitest.mjs", "run", testFile, "--no-file-parallelism"], {
      stdio: "inherit",
      env: testEnvironment,
    });
  }
} finally {
  functions.kill("SIGTERM");
  await rm(functionEnvFile, { force: true });
}
