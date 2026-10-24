// Where the server gets its database and OpenAI settings:
//
// - On Prisma: from the service declaration (service.ts). The database comes
//   from service.load() and the OpenAI settings from service.input(), which
//   reads the project's environment variables bound in module.ts.
// - Locally (npm run dev): from .env, as the scripts do.
//
// Prisma passes the service's configuration in COMPOSER_* variables, so their
// presence tells the two apart.

import pgvector from "@prisma/orm-extension-pgvector/runtime";
import service from "../service.ts";
import { db as localDb } from "../src/prisma/db.ts";
import { configureOpenAI } from "./openai.ts";

export type Db = typeof localDb;

type AppConfig = {
  runningOn: "prisma" | "local";
  /** null when the server has no database configured */
  db: Db | null;
  /** Whether an OpenAI key is configured */
  openai: boolean;
};

let config: AppConfig | null = null;

export function appConfig(): AppConfig {
  if (config) return config;

  if (process.env.COMPOSER_DATABASE_URL) {
    const { database } = service.load();
    const input = service.input();
    configureOpenAI({ apiKey: input.openaiApiKey.expose(), baseURL: input.openaiBaseUrl || undefined });
    config = { runningOn: "prisma", db: database.clientWith({ extensions: [pgvector] }), openai: true };
  } else {
    config = {
      runningOn: "local",
      db: process.env.DATABASE_URL ? localDb : null,
      openai: Boolean(process.env.OPENAI_API_KEY),
    };
  }
  return config;
}
