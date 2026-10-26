import { Router } from "express";
import { checkLogin, cookieOptions, createSession, getCookie, readSession, SESSION_COOKIE } from "../lib/auth.ts";
import { appConfig } from "../lib/config.ts";
import { takeLoginAttempt } from "../lib/limits.ts";

const router = Router();

// POST /api/login { "username": "user", "password": "…" } → sets the session cookie
router.post("/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    res.status(400).json({ error: "`username` and `password` are required" });
    return;
  }

  const limit = takeLoginAttempt(req.ip ?? "unknown");
  if (!limit.ok) {
    res.set("Retry-After", String(limit.retryAfterSeconds)).status(429).json({ error: limit.error });
    return;
  }

  const { accounts, sessionSecret } = await appConfig();
  if (!sessionSecret || accounts.length === 0) {
    res.status(503).json({ error: "Login is not configured on this server" });
    return;
  }

  const user = checkLogin(accounts, username, password);
  if (!user) {
    res.status(401).json({ error: "Wrong username or password" });
    return;
  }
  const session = createSession(user, sessionSecret);
  res.cookie(SESSION_COOKIE, session.value, cookieOptions(req, session.maxAgeMs)).json(user);
});

// POST /api/logout → clears the session cookie
router.post("/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req)).json({ ok: true });
});

// GET /api/me → the logged-in user, for the frontend to know whether to show the login screen
router.get("/me", async (req, res) => {
  const { sessionSecret } = await appConfig();
  const user = sessionSecret ? readSession(getCookie(req, SESSION_COOKIE), sessionSecret) : null;
  if (!user) {
    res.status(401).json({ error: "Please log in" });
    return;
  }
  res.json(user);
});

export default router;
