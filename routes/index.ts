import { Router } from "express";
import { appConfig } from "../lib/config.ts";
import { searchManuals } from "../lib/search.ts";

const router = Router();
const DEFAULT_K = 5;
const MAX_K = 20;
const MAX_QUERY_LENGTH = 1000;

// POST /search { "query": "What's the oil capacity for the 3.0 L engine on a 2026 MDX?", "k": 5 }
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
  try {
    const { db, openai } = appConfig();
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

export default router;
