// Run: npm run evals   (needs TYPESAFE_API_KEY in .env; the server is started for you on port 3100)
//
// Each case sends a question to POST /api/chat and asks a TypeSafe judge
// whether the reply meets the case's criteria. The judge's score (0 to 1)
// must reach the case's threshold.
//
// /api/chat needs a logged-in user. Instead of logging in with a password,
// the evals sign their own session cookie with SESSION_SECRET, as /api/login
// would. Each user gets 20 questions per hour (lib/limits.ts), counted from
// when the server starts, so keep a run under 20 requests: one per case, plus
// one per `history` message.
import "../env.ts";
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../agents/manual-assistant.ts";
import { createSession, SESSION_COOKIE } from "../auth.ts";
import { EVALS_URL } from "./server.ts";

const judge = new TypeSafeClient();
const api = request(EVALS_URL);

if (!process.env.SESSION_SECRET) throw new Error("The evals need SESSION_SECRET in .env to log in");
const session = createSession({ username: `evals-${Date.now()}`, role: "user" }, process.env.SESSION_SECRET);
const cookie = `${SESSION_COOKIE}=${session.value}`;

// Add a case = add an object. threshold = minimum judge score (0 to 1).
// `history`: earlier user messages, each sent (and answered by the agent) before `question`.
type Case = { question: string; history?: string[]; criteria: string; threshold: number };

const CASES: Case[] = [
  // Answers from the manual
  {
    question: "What is the engine oil capacity for the 3.0 L engine on a 2026 MDX?",
    criteria:
      "Gives the engine oil capacity in US quarts (5.2 US qt, or 5.5 US qt with the filter) and cites the 2026 MDX Owner's Manual with a page number",
    threshold: 0.8,
  },
  {
    question: "What tire pressure should I use on my 2026 MDX?",
    criteria: "Gives a tire pressure in psi (35 psi) and cites the 2026 MDX Owner's Manual with a page number",
    threshold: 0.8,
  },
  {
    question: "How do I change the engine oil on my 2026 MDX?",
    criteria:
      "Starts by advising the user to set up an appointment with an Acura dealer, then gives the manual's oil change steps or says the manual doesn't describe them",
    threshold: 0.8,
  },
  {
    question: "How much does an oil change cost at the dealer for my 2026 MDX?",
    criteria: "Says the manual doesn't list prices and suggests contacting an Acura dealer; does not state a price",
    threshold: 0.8,
  },

  // Working out the vehicle
  {
    question: "How do I pair my phone with my car?",
    criteria: "Asks for the vehicle's model year and model; gives no pairing steps",
    threshold: 0.8,
  },
  {
    history: ["How do I pair my phone with my car?"],
    question: "It's a 2024 ZDX",
    criteria: "Gives steps for pairing a phone with the 2024 ZDX and cites the 2024 ZDX manual with page numbers",
    threshold: 0.8,
  },
  {
    history: ["What tire pressure should I use on my 2026 MDX?"],
    question: "And how much oil does the 3.0 L engine take?",
    criteria:
      "Answers for the 2026 MDX without asking which vehicle; gives the oil capacity in US quarts (5.2 or 5.5 US qt)",
    threshold: 0.8,
  },
  {
    history: ["How do I pair my phone with my 2026 Integra?"],
    question: "How do I check the tire pressure on my MDX?",
    criteria: "Asks which model year the MDX is; does not assume 2026 and gives no tire pressure steps",
    threshold: 0.8,
  },
  {
    question: "How do I pair my phone with my 2027 MDX?",
    criteria: "Says there's no manual for a 2027 MDX and mentions the MDX years it has (2022 to 2026); gives no pairing steps",
    threshold: 0.8,
  },

  // Out of scope
  {
    question: "What is the capital of Ecuador?",
    criteria: 'Declines with "Please ask a question about Acura cars."; does not say Quito',
    threshold: 0.9,
  },
  {
    question: "Write me a Python function that sorts a list",
    criteria: "Declines and asks for a question about Acura cars; contains no code",
    threshold: 0.9,
  },
  {
    question: "What is the oil capacity of a 2024 Toyota Camry?",
    criteria: "Declines because it only answers about Acura vehicles; gives no oil capacity",
    threshold: 0.8,
  },
  {
    question: "My 2024 RDX makes a grinding noise when I brake, how do I fix it?",
    criteria:
      "Declines to diagnose or explain a fix and tells the user to set up an appointment with an Acura dealer; gives no repair steps",
    threshold: 0.9,
  },
];

/** Sends the conversation to /api/chat and returns the agent's reply */
async function ask(messages: ChatMessage[]): Promise<string> {
  const res = await api.post("/api/chat").set("Cookie", cookie).send({ messages });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.reply;
}

describe("chat answers", () => {
  it.each(CASES)(
    "$question",
    async ({ question, history = [], criteria, threshold }) => {
      const conversation: ChatMessage[] = [];
      for (const earlier of history) {
        conversation.push({ role: "user", content: earlier });
        conversation.push({ role: "assistant", content: await ask(conversation) });
      }
      conversation.push({ role: "user", content: question });
      const answer = await ask(conversation);

      const { answers } = await judge.systemOne({
        state: {
          earlierMessages: conversation.slice(0, -1).map((m) => `${m.role}: ${m.content}`).join("\n\n"),
          question,
          answer,
        },
        questions: {
          met: noul(`Does the answer meet this criteria: ${criteria}`),
        },
      });

      console.log(`score ${answers.met.noul.toFixed(2)} | ${answer}`);
      expect(answers.met.noul).toBeGreaterThanOrEqual(threshold);
    },
    120_000,
  );
});
