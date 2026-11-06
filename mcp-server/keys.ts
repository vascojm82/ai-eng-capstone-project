// API keys of the external agents allowed to call the MCP tools (server.ts),
// kept in the mcp_keys table. This file doesn't manage the table: it makes
// keys and checks them. Who does what:
//
// - scripts/mcp/keys.ts (`npm run mcp:keys`) writes the table: `create` adds a
//   client with newKey() below, `revoke` sets its revoked_at, `list` reads it.
//   It writes straight to the database in DATABASE_URL, the same one the
//   deployed app reads, so a new key works in production right away, without
//   a deploy.
// - The server (routes/mcp.ts) calls findKeyOwner() on every request. It reads
//   the table, and only writes last_used_at (at most every TOUCH_MS per client).
//   It remembers each answer for CACHE_MS (a minute), so a revoked key stops
//   working within a minute, without a database read on every call.
//
// A key is "sam_" + 43 random characters (32 bytes). Only its SHA-256 hash is
// stored, never the key: newKey() returns the key once, for the script to show,
// and only its hash and prefix go into the table. A key is long and random, so
// unlike a password it can't be guessed, and a fast hash is as safe as scrypt
// while costing nothing per request. The first characters are kept as the
// key's prefix, to tell keys apart in lists and logs.

import { createHash, randomBytes } from "crypto";
import type { Db } from "../lib/config.ts";

const KEY_PREFIX = "sam_";
const PREFIX_LENGTH = 12; // "sam_" + 8 random characters
// How long a looked-up key is trusted before the database is read again, so a
// revoked key stops working within this time without a lookup on every call
const CACHE_MS = 60 * 1000;
// last_used_at is written at most this often per client
const TOUCH_MS = 5 * 60 * 1000;

/** Who a key belongs to: one row of mcp_keys (an external agent using our MCP server, e.g. a dealer's bot) */
export type McpKeyOwner = { id: number; name: string; keyPrefix: string; hourlyLimit: number | null };

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new random key, its prefix and its hash (only the hash and prefix are stored) */
export function newKey(): { key: string; keyPrefix: string; keyHash: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, keyPrefix: key.slice(0, PREFIX_LENGTH), keyHash: hashKey(key) };
}

const cache = new Map<string, { owner: McpKeyOwner | null; at: number }>();
const touchedAt = new Map<number, number>();

/** Who a key belongs to, or null when it's unknown or revoked */
export async function findKeyOwner(db: Db, key: string, now = Date.now()): Promise<McpKeyOwner | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const keyHash = hashKey(key);
  const cached = cache.get(keyHash);
  let owner = cached && now - cached.at < CACHE_MS ? cached.owner : undefined;
  if (owner === undefined) {
    const row = await db.orm.public.McpKey.where({ keyHash })
      .select("id", "name", "keyPrefix", "hourlyLimit", "revokedAt")
      .first();
    owner = row && !row.revokedAt ? { id: row.id, name: row.name, keyPrefix: row.keyPrefix, hourlyLimit: row.hourlyLimit } : null;
    cache.set(keyHash, { owner, at: now });
  }
  if (owner && now - (touchedAt.get(owner.id) ?? 0) > TOUCH_MS) {
    touchedAt.set(owner.id, now);
    await db.orm.public.McpKey.where({ id: owner.id }).update({ lastUsedAt: new Date(now).toISOString() });
  }
  return owner;
}
