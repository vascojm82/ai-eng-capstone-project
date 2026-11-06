import { Router, type Request, type Response } from "express";
import { runAgent, type ChatMessage } from "../agents/manual-assistant.ts";
import { requireAuth } from "../lib/auth.ts";
import { appConfig } from "../lib/config.ts";
import { takeQuestion } from "../lib/limits.ts";
import { searchManuals } from "../lib/search.ts";
import { parseBody } from "../lib/validation.ts";
import { z } from "zod";

const router = Router();
const DEFAULT_K = 5;
const MAX_K = 20;
const MAX_QUERY_LENGTH = 1000;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 4000;

const K_ERROR = `\`k\` must be an integer from 1 to ${MAX_K}`;
const SearchBody = z.object({
  query: z
    .string({ error: "`query` must be a non-empty string" })
    .max(MAX_QUERY_LENGTH, `\`query\` must be at most ${MAX_QUERY_LENGTH} characters`)
    .trim()
    .min(1, "`query` must be a non-empty string"),
  k: z.int({ error: K_ERROR }).min(1, K_ERROR).max(MAX_K, K_ERROR).default(DEFAULT_K),
});

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_MESSAGE_LENGTH).refine((text) => text.trim() !== ""),
      }) satisfies z.ZodType<ChatMessage>,
    )
    .min(1)
    .max(MAX_MESSAGES)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
const CHAT_ERROR =
  `\`messages\` must be 1 to ${MAX_MESSAGES} messages of { role: "user" | "assistant", content: string } ` +
  `(each at most ${MAX_MESSAGE_LENGTH} characters), ending with a user message`;

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
  const body = parseBody(SearchBody, req, res);
  if (!body) return;
  const { query, k } = body; // query is trimmed
  if (!withinLimits(req, res)) return;
  try {
    const { db, openai } = await appConfig();
    if (!db || !openai) {
      res.status(503).json({ error: "Search is not configured on this server (database or OpenAI settings missing)" });
      return;
    }
    const { status, ...outcome } = await searchManuals(db, query, k);
    // ok → 200; the question doesn't say which vehicle → 422; no manuals for that vehicle → 404
    const code = status === "ok" ? 200 : status === "needs_vehicle" ? 422 : 404;
    res.status(code).json({ query, k, ...outcome });
  } catch (err) {
    console.error("POST /search failed:", err);
    res.status(500).json({ error: "Search failed, please try again" });
  }
});

// POST /api/chat { "messages": [{ "role": "user", "content": "How do I pair my phone with my 2024 ZDX?" }] }
// The client sends the whole conversation each time (the server keeps no
// state); the last message must be the user's.
router.post("/chat", async (req, res) => {
  const body = parseBody(ChatBody, req, res, CHAT_ERROR);
  if (!body) return;
  const { messages } = body;
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
