// Vitest global setup for the evals: starts the API server (server.ts, with
// tsx) on its own port, EVALS_PORT (default 3100), waits until it answers,
// and stops it when the evals are done. Its own port, not the dev server's
// 3000, so the evals never talk to some other app running there, and each run
// starts with fresh usage-limit counters. The server reads .env as usual, so
// it needs DATABASE_URL, OPENAI_API_KEY and SESSION_SECRET there.

import { spawn } from "child_process";

export const EVALS_PORT = Number(process.env.EVALS_PORT) || 3100;
export const EVALS_URL = `http://localhost:${EVALS_PORT}`;
const STARTUP_TIMEOUT_MS = 30_000;

async function isUp(): Promise<boolean> {
  try {
    await fetch(`${EVALS_URL}/api/me`);
    return true;
  } catch {
    return false;
  }
}

export default async function setup() {
  if (await isUp()) {
    throw new Error(`Port ${EVALS_PORT} is already in use; stop that process or pick another with EVALS_PORT`);
  }

  // node --import tsx (rather than npx tsx) so there's a single process to stop afterwards
  const server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: { ...process.env, PORT: String(EVALS_PORT) },
    stdio: ["ignore", "ignore", "inherit"], // keep the server's errors, e.g. "POST /chat failed"
  });
  let exited = false;
  server.on("exit", () => (exited = true));

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!(await isUp())) {
    if (exited) throw new Error("The API server exited on startup; run `npm run dev` to see why");
    if (Date.now() > deadline) {
      server.kill();
      throw new Error(`The API server didn't answer on ${EVALS_URL} within ${STARTUP_TIMEOUT_MS / 1000} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return () => {
    server.kill();
  };
}
