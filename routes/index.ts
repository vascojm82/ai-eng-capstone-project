import { Router, type Request, type Response } from "express";
import { runAgent, type ChatMessage } from "../agents/manual-assistant.ts";
import { requireAuth } from "../lib/auth.ts";
import { appConfig } from "../lib/config.ts";
import { takeQuestion } from "../lib/limits.ts";
import { searchManuals } from "../lib/search.ts";

const router = Router();
const DEFAULT_K = 5;
const MAX_K = 20;
const MAX_QUERY_LENGTH = 1000;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 4000;

// Everything below needs a logged-in user (see routes/auth.ts for /api/login)
router.use(requireAuth(async () => (await appConfig()).sessionSecret));

/** Counts the question against the user's and the app's limits; answers 429 and returns false when over */
function withinLimits(req: Request, res: Response): boolean {
  const limit = takeQuestion(req.user!.username);
  if (limit.ok) return true;
  res.set("Retry-After", String(limit.retryAfterSeconds)).status(429).json({ error: limit.error });
  return false;
}

// POST /api/search { "query": "What's the oil capacity for the 3.0 L engine on a 2026 MDX?", "k": 5 }
router.post("/search", async (req, res) => {
  const { query, k = DEFAULT_K } = req.body ?? {};

  if (typeof query !== "string" || query.trim() === "") {
    res.status(400).json({ error: "`query` must be a non-empty string" });
    return;
  }
  if (query.length > MAX_QUERY_LENGTH) {
    res.status(400).json({ error: `\`query\` must be at most ${MAX_QUERY_LENGTH} characters` });
    return;
  }
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) {
    res.status(400).json({ error: `\`k\` must be an integer from 1 to ${MAX_K}` });
    return;
  }
  if (!withinLimits(req, res)) return;
  try {
    const { db, openai } = await appConfig();
    if (!db || !openai) {
      res.status(503).json({ error: "Search is not configured on this server (database or OpenAI settings missing)" });
      return;
    }
    const outcome = await searchManuals(db, query.trim(), k);
    const { status, ...body } = outcome;
    // ok → 200; the question doesn't say which vehicle → 422; no manuals for that vehicle → 404
    const code = status === "ok" ? 200 : status === "needs_vehicle" ? 422 : 404;
    res.status(code).json({ query: query.trim(), k, ...body });
  } catch (err) {
    console.error("POST /search failed:", err);
    res.status(500).json({ error: "Search failed, please try again" });
  }
});

// POST /api/chat { "messages": [{ "role": "user", "content": "How do I pair my phone with my 2024 ZDX?" }] }
// The client sends the whole conversation each time (the server keeps no
// state); the last message must be the user's.
router.post("/chat", async (req, res) => {
  const { messages } = req.body ?? {};

  const valid =
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= MAX_MESSAGES &&
    messages.every(
      (m: unknown): m is ChatMessage =>
        typeof m === "object" &&
        m !== null &&
        ((m as ChatMessage).role === "user" || (m as ChatMessage).role === "assistant") &&
        typeof (m as ChatMessage).content === "string" &&
        (m as ChatMessage).content.trim() !== "" &&
        (m as ChatMessage).content.length <= MAX_MESSAGE_LENGTH,
    ) &&
    messages[messages.length - 1].role === "user";
  if (!valid) {
    res.status(400).json({
      error:
        `\`messages\` must be 1 to ${MAX_MESSAGES} messages of { role: "user" | "assistant", content: string } ` +
        `(each at most ${MAX_MESSAGE_LENGTH} characters), ending with a user message`,
    });
    return;
  }
  if (!withinLimits(req, res)) return;
  try {
    const { db, openai } = await appConfig();
    if (!db || !openai) {
      res.status(503).json({ error: "Chat is not configured on this server (database or OpenAI settings missing)" });
      return;
    }
    res.json(await runAgent(db, messages));
  } catch (err) {
    console.error("POST /chat failed:", err);
    res.status(500).json({ error: "Something went wrong, please try again" });
  }
});

export default router;
