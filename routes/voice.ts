import express, { Router } from "express";
import { verify } from "retell-sdk";
import { runAgent } from "../agents/manual-assistant.ts";
import { appConfig } from "../lib/config.ts";
import { takeVoiceQuestion } from "../lib/limits.ts";
import { z } from "zod";

// The phone agent's tool. Retell runs the call (speech, its own LLM, the
// voice); when the caller asks about their car, Retell's LLM calls the
// owners_manual_lookup custom tool, which POSTs here:
//
//   { "name": "owners_manual_lookup",
//     "call": { "call_id": "…", "from_number": "+1…", "transcript": "…", … },
//     "args": { "question": "How do I check the tire pressure on a 2026 MDX?" } }
//
// and Retell's LLM reads our { "answer": "…" } to the caller.
//
// There's no login here: every request must carry Retell's X-Retell-Signature,
// an HMAC of the exact body made with our Retell API key, with a timestamp
// that expires after 5 minutes. That's why this router reads the raw body
// itself and is mounted before express.json() in server.ts: the signature
// can't be checked against JSON that's been parsed and serialized again.

const router = Router();
const MAX_QUESTION_LENGTH = 1000;
// Retell sends the whole call so far (transcript included) with every request
const MAX_BODY_SIZE = "2mb";

// The parts of Retell's request we use; the rest of the call (transcript…) is ignored
const VoicePayload = z.object({
  call: z.object({ call_id: z.string().nullish(), from_number: z.string().nullish() }).nullish(),
  args: z.object({ question: z.string().max(MAX_QUESTION_LENGTH).trim().min(1) }),
});

// POST /api/voice/ask (from Retell only)
router.post("/voice/ask", express.raw({ type: "application/json", limit: MAX_BODY_SIZE }), async (req, res) => {
  try {
    const { db, openai, retellApiKey } = await appConfig();
    if (!retellApiKey) {
      res.status(503).json({ error: "Voice is not configured on this server (RETELL_API_KEY missing)" });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.get("x-retell-signature") ?? "";
    if (!rawBody || !(await verify(rawBody, retellApiKey, signature))) {
      res.status(401).json({ error: "Invalid or missing Retell signature" });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      res.status(400).json({ error: "Request body must be valid JSON" });
      return;
    }
    const parsed = VoicePayload.safeParse(json);
    if (!parsed.success) {
      res.status(400).json({ error: `\`args.question\` must be a non-empty string of at most ${MAX_QUESTION_LENGTH} characters` });
      return;
    }
    const payload = parsed.data;
    const { question } = payload.args; // trimmed

    // Limit by the caller's phone number (web calls have none: then by call)
    const caller = payload.call?.from_number || payload.call?.call_id || "unknown";
    const limit = takeVoiceQuestion(caller);
    if (!limit.ok) {
      // 200, so Retell's LLM reads the message to the caller instead of treating it as a failed tool call
      res.json({ answer: limit.error });
      return;
    }

    if (!db || !openai) {
      res.status(503).json({ error: "Voice is not configured on this server (database or OpenAI settings missing)" });
      return;
    }
    const { reply } = await runAgent(db, [{ role: "user", content: question }], { voice: true });
    res.json({ answer: reply });
  } catch (err) {
    console.error("POST /voice/ask failed:", err);
    res.status(500).json({ error: "Something went wrong, please try again" });
  }
});

export default router;
