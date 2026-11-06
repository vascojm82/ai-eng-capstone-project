/**
 * API keys for the external agents that call the MCP server (routes/mcp.ts).
 * Works on the database in DATABASE_URL, so locally it manages the same
 * clients the deployed app checks.
 *
 * Usage:
 *   npm run mcp:keys -- create "Acme dealer bot"              # prints the new key, once
 *   npm run mcp:keys -- create "Acme dealer bot" --limit 120  # with its own tool calls per hour
 *   npm run mcp:keys -- list
 *   npm run mcp:keys -- revoke sam_8f3kQ2xa                    # by the prefix `list` shows
 *
 * Only the key's hash is stored: a lost key can't be shown again, create a new
 * one and revoke the old. A revoked key stops working within a minute.
 */

import { newKey } from "../../lib/mcp-keys.ts";
import { MCP_CALLS_PER_CLIENT_PER_HOUR } from "../../lib/limits.ts";
import { db } from "../../src/prisma/db.ts";

const USAGE = 'Usage: npm run mcp:keys -- create "<client name>" [--limit <calls per hour>] | list | revoke <key prefix>';

async function create(args: string[]) {
  const limitAt = args.indexOf("--limit");
  const hourlyLimit = limitAt === -1 ? null : Number(args[limitAt + 1]);
  // The name is every argument except --limit and its value
  const nameArgs = limitAt === -1 ? args : args.filter((_, i) => i !== limitAt && i !== limitAt + 1);
  const name = nameArgs.join(" ").trim();
  if (!name) throw new Error(USAGE);
  if (hourlyLimit !== null && !(Number.isInteger(hourlyLimit) && hourlyLimit > 0)) {
    throw new Error("--limit must be a whole number of tool calls per hour, e.g. --limit 120");
  }

  const { key, keyPrefix, keyHash } = newKey();
  await db.orm.public.McpKey.create({ name, keyPrefix, keyHash, hourlyLimit, createdAt: new Date().toISOString() });
  console.log(`Created a key for "${name}" (${hourlyLimit ?? MCP_CALLS_PER_CLIENT_PER_HOUR} tool calls per hour):\n`);
  console.log(`  ${key}\n`);
  console.log("Send it to the client privately. It's shown only this once: only its hash is stored.");
  console.log("The client sends it with every request:  Authorization: Bearer <key>");
}

async function list() {
  const rows = [];
  for await (const row of db.orm.public.McpKey.orderBy((c) => c.id.asc()).all()) rows.push(row);
  if (rows.length === 0) {
    console.log('No keys yet. Create one with: npm run mcp:keys -- create "<client name>"');
    return;
  }
  console.table(
    rows.map((r) => ({
      prefix: r.keyPrefix,
      name: r.name,
      "calls/hour": r.hourlyLimit ?? `${MCP_CALLS_PER_CLIENT_PER_HOUR} (default)`,
      created: r.createdAt.slice(0, 10),
      "last used": r.lastUsedAt?.slice(0, 16).replace("T", " ") ?? "never",
      status: r.revokedAt ? `revoked ${r.revokedAt.slice(0, 10)}` : "active",
    })),
  );
}

async function revoke(prefix: string | undefined) {
  if (!prefix) throw new Error(USAGE);
  const client = await db.orm.public.McpKey.where({ keyPrefix: prefix }).first();
  if (!client) throw new Error(`No key with the prefix ${prefix}; see npm run mcp:keys -- list`);
  if (client.revokedAt) {
    console.log(`The key of "${client.name}" was already revoked on ${client.revokedAt.slice(0, 10)}.`);
    return;
  }
  await db.orm.public.McpKey.where({ id: client.id }).update({ revokedAt: new Date().toISOString() });
  console.log(`Revoked the key of "${client.name}" (${prefix}). It stops working within a minute.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create") await create(args);
  else if (command === "list") await list();
  else if (command === "revoke") await revoke(args[0]);
  else throw new Error(USAGE);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
