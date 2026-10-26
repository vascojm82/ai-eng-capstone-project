/**
 * Creates the login accounts: `user` (role user) and `admin` (role admin).
 *
 * Generates a strong random password for each, stores only their scrypt
 * hashes in .env as APP_USERS, generates SESSION_SECRET (which signs the
 * session cookies), and writes the passwords to .credentials.local, a
 * gitignored file for you to keep. The passwords are never printed.
 *
 * Existing accounts are kept unless --force is passed (which replaces both
 * passwords and the session secret, logging everyone out).
 *
 * Usage:
 *   npm run auth:users
 *   npm run auth:users -- --force
 *
 * For production, add the same two values to Prisma afterwards:
 *   set -a; source .env; set +a
 *   npx prisma project env add APP_USERS --role production
 *   npx prisma project env add SESSION_SECRET --role production
 */

import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { hashPassword } from "../../lib/auth.ts";

const ENV_FILE = ".env";
const CREDENTIALS_FILE = ".credentials.local";
const ACCOUNTS = [
  { username: "user", role: "user" },
  { username: "admin", role: "admin" },
] as const;

/** Replaces KEY=… in the .env text, or appends it */
function setEnv(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
}

function main() {
  const force = process.argv.includes("--force");
  const env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "";
  if (/^APP_USERS=./m.test(env) && !force) {
    console.log(`APP_USERS is already set in ${ENV_FILE}; nothing changed. Pass --force to create new passwords.`);
    return;
  }

  // 18 random bytes → 24 base64url characters, about 144 bits
  const passwords = ACCOUNTS.map((a) => ({ ...a, password: randomBytes(18).toString("base64url") }));
  const appUsers = passwords.map((a) => `${a.username}:${a.role}:${hashPassword(a.password)}`).join(",");
  const sessionSecret = randomBytes(32).toString("base64url");

  writeFileSync(ENV_FILE, setEnv(setEnv(env, "APP_USERS", appUsers), "SESSION_SECRET", sessionSecret));
  writeFileSync(
    CREDENTIALS_FILE,
    [
      "# Login passwords for the Acura manual assistant. Keep this file private; it's gitignored.",
      `# Created ${new Date().toISOString()} by npm run auth:users`,
      ...passwords.map((a) => `${a.username} (${a.role}): ${a.password}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  console.log(`Created ${passwords.map((a) => a.username).join(" and ")}.`);
  console.log(`- APP_USERS (password hashes) and SESSION_SECRET written to ${ENV_FILE}`);
  console.log(`- passwords written to ${CREDENTIALS_FILE} (only readable by you)`);
}

main();
