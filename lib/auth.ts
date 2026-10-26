// Login: the accounts, password checks and the session cookie.
//
// - Accounts come from the APP_USERS setting, never from code:
//     APP_USERS=user:user:scrypt.<salt>.<hash>,admin:admin:scrypt.<salt>.<hash>
//   (username:role:password hash, comma-separated). Passwords are stored only
//   as scrypt hashes; `npm run auth:users` creates them.
// - After a login, the browser gets a session cookie: the username, role and
//   expiry, signed with SESSION_SECRET (HMAC-SHA256) so it can't be forged or
//   edited. The server keeps no session state.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

export type Role = "user" | "admin";
export type SessionUser = { username: string; role: Role };
type Account = SessionUser & { passwordHash: string };

export const SESSION_COOKIE = "session";
const SESSION_DAYS = 7;
const SCRYPT_KEY_LENGTH = 64;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** "scrypt.<salt>.<hash>", both base64url: safe in .env files and shell commands */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(".");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Parse APP_USERS; malformed entries are skipped */
export function parseAccounts(appUsers: string | undefined): Account[] {
  return (appUsers ?? "")
    .split(",")
    .map((entry) => entry.trim().split(":"))
    .filter(([username, role, passwordHash]) => username && (role === "user" || role === "admin") && passwordHash)
    .map(([username, role, passwordHash]) => ({ username, role: role as Role, passwordHash }));
}

// A fixed hash, checked when the username doesn't exist, so a wrong username
// takes as long as a wrong password and doesn't reveal which accounts exist.
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

export function checkLogin(accounts: Account[], username: string, password: string): SessionUser | null {
  const account = accounts.find((a) => a.username === username);
  const ok = verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
  return account && ok ? { username: account.username, role: account.role } : null;
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** The cookie value: base64url(JSON payload) + "." + signature */
export function createSession(user: SessionUser, secret: string): { value: string; maxAgeMs: number } {
  const maxAgeMs = SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + maxAgeMs })).toString("base64url");
  return { value: `${payload}.${sign(payload, secret)}`, maxAgeMs };
}

/** The logged-in user, or null when the cookie is missing, tampered with or expired */
export function readSession(value: string | undefined, secret: string): SessionUser | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const { username, role, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof exp !== "number" || exp < Date.now()) return null;
    return { username, role };
  } catch {
    return null;
  }
}

/** The value of one cookie from the request's Cookie header */
export function getCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** Cookie options: httpOnly (no JavaScript access), sameSite lax, secure over HTTPS */
export const cookieOptions = (req: Request, maxAgeMs?: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: req.secure,
  path: "/",
  ...(maxAgeMs !== undefined && { maxAge: maxAgeMs }),
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireAuth for logged-in requests */
    user?: SessionUser;
  }
}

/** Lets the request through only with a valid session; answers 401 otherwise */
export function requireAuth(getSecret: () => Promise<string | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const secret = await getSecret();
    if (!secret) {
      res.status(503).json({ error: "Login is not configured on this server" });
      return;
    }
    const user = readSession(getCookie(req, SESSION_COOKIE), secret);
    if (!user) {
      res.status(401).json({ error: "Please log in" });
      return;
    }
    req.user = user;
    next();
  };
}
