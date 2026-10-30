// Where the server gets its database, OpenAI, login and Retell settings:
//
// - On Prisma: from the service declaration (service.ts). The database comes
//   from service.load() and the other settings from service.input(),
//   which reads the project's environment variables bound in module.ts.
// - Locally (npm run dev): from .env, as the scripts do.
//
// Prisma passes the service's configuration in COMPOSER_* variables, so their
// presence tells the two apart. The local client (src/prisma/db.ts) is only
// imported locally: it's built from DATABASE_URL as soon as it's imported, and
// on Prisma that variable isn't a URL the client can use, so importing it there
// would crash the server at startup.

import pgvector from "@prisma/orm-extension-pgvector/runtime";
import service from "../service.ts";
import type { db as localDb } from "../src/prisma/db.ts";
import { parseAccounts } from "./auth.ts";
import { configureOpenAI } from "./openai.ts";

export type Db = typeof localDb;

type AppConfig = {
  runningOn: "prisma" | "local";
  /** null when the server has no database configured */
  db: Db | null;
  /** Whether an OpenAI key is configured */
  openai: boolean;
  /** The login accounts from APP_USERS (empty when not configured) */
  accounts: ReturnType<typeof parseAccounts>;
  /** Signs the session cookies; null when not configured */
  sessionSecret: string | null;
  /** Verifies that /api/voice/ask requests come from Retell; null when not configured */
  retellApiKey: string | null;
};

let config: AppConfig | null = null;

export async function appConfig(): Promise<AppConfig> {
  if (config) return config;

  if (process.env.COMPOSER_DATABASE_URL) {
    const { database } = service.load();
    const input = service.input();
    configureOpenAI({ apiKey: input.openaiApiKey.expose(), baseURL: input.openaiBaseUrl || undefined });
    config = {
      runningOn: "prisma",
      db: database.clientWith({ extensions: [pgvector] }),
      openai: true,
      accounts: parseAccounts(input.appUsers.expose()),
      sessionSecret: input.sessionSecret.expose(),
      retellApiKey: input.retellApiKey.expose(),
    };
  } else {
    const db = process.env.DATABASE_URL ? (await import("../src/prisma/db.ts")).db : null;
    config = {
      runningOn: "local",
      db,
      openai: Boolean(process.env.OPENAI_API_KEY),
      accounts: parseAccounts(process.env.APP_USERS),
      sessionSecret: process.env.SESSION_SECRET || null,
      retellApiKey: process.env.RETELL_API_KEY || null,
    };
  }
  return config;
}
