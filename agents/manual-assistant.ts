/**
 * The manual assistant: one agent that answers questions about Acura vehicles
 * from their owner's and navigation manuals.
 *
 * It's an LLM with instructions and two tools:
 *   - find_manuals:   which vehicles and manuals we have (SQL)
 *   - search_manuals: the passages of the right manuals closest to a question
 *                     (pgvector search, limited to that vehicle's manuals)
 *
 * The model decides when to call them: it asks for the vehicle when it doesn't
 * know it, searches once it does, and answers only from the passages found,
 * citing the manual and page. Each call to runAgent() gets the whole
 * conversation, so the server keeps no state between messages. The model sees
 * only the last HISTORY_MESSAGES of it, but the vehicle is looked up in all of
 * it, so a car named early in a long chat isn't forgotten.
 */

import type OpenAI from "openai";
import type { Db } from "../lib/config.ts";
import { openai } from "../lib/openai.ts";
import { findManuals, searchManuals, type SearchResult } from "../lib/search.ts";
import { detectVehicle } from "../lib/vehicles.ts";

// GPT-6 Luna, the small GPT-6 model, unless OPENAI_CHAT_MODEL picks another one.
// gpt-4.1-mini, used before, leaves OpenAI's API on January 14, 2027.
// Among GPT-6 models only Luna and Sol work here: the agent needs reasoning_effort
// "none" (tools in Chat Completions) and temperature, which Astra and 6.1 Sol reject.
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-6-luna";
const isGpt6 = CHAT_MODEL.startsWith("gpt-6");
const MAX_TOOL_ROUNDS = 5; // model ↔ tools round trips per message, so a confused model can't loop forever
const HISTORY_MESSAGES = 5; // the latest user/assistant messages the model sees, the current question included
const DEFAULT_K = 5;

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type Source = { manual: string; docCode: string; page: number; section: string | null; url: string };

export type AgentReply = {
  reply: string;
  /** The manual pages the reply cites */
  sources: Source[];
  /** The tools the agent called for this message, in order */
  steps: { tool: string; args: unknown; status?: string }[];
};

/** Put before the manual's steps for engine oil, transmission fluid and brake pad changes */
const DEALER_NOTICE = "We advise you to set up an appointment to get this done with an Acura dealer.";

/**
 * Few-shot examples of what the assistant should and shouldn't handle. Each one
 * is shown to the model in the system prompt: for "reject", the exact reply to
 * give (without searching); for "answer", why it's in scope, plus a `notice`
 * the answer must start with, when there is one.
 */
const fewShotExamples: { query: string; action: "reject" | "answer"; reason: string; notice?: string }[] = [
  {
    query: "What is the capital of Germany",
    action: "reject",
    reason: "Please ask a question about Acura cars.",
  },
  {
    query: "Give advice on how to fix my car",
    action: "reject",
    reason: "We never advise on fixing the car yourself. Please set up an appointment with an Acura dealer.",
  },
  {
    query: "How do I change the engine oil on my 2026 MDX?",
    action: "answer",
    reason: "the owner's manual gives this procedure, so search and answer from it like any other question",
    notice: DEALER_NOTICE,
  },
  {
    query: "How do I change the transmission fluid on my 2024 RDX?",
    action: "answer",
    reason: "search the manual; give its steps if it has them, otherwise say the manual doesn't describe it",
    notice: DEALER_NOTICE,
  },
  {
    query: "How do I replace the brake pads on my 2025 TLX?",
    action: "answer",
    reason: "a planned brake pad change, not a repair: search the manual; give its steps if it has them, otherwise say the manual doesn't describe it",
    notice: DEALER_NOTICE,
  },
];

const SCOPE_RULES = `Scope (check this first, before anything else):
- You only answer questions about Acura vehicles and their manuals. For anything else (geography, general knowledge, other car brands, coding, …), don't search and don't ask for the vehicle: reply exactly "${fewShotExamples[0].reason}"
- Don't diagnose or repair problems (strange noises, warning lights that stay on, broken parts, "how do I fix my car"): reply exactly "${fewShotExamples[1].reason}" Procedures the manual itself gives (changing the oil, jump starting, the tire repair kit, replacing a fuse…) are in scope: answer them from the manual.
- Engine oil changes, transmission fluid (oil) changes and brake pad changes: start the answer with exactly "${DEALER_NOTICE}" on its own line, then give the manual's instructions if it has them (or say the manual doesn't describe the procedure). A planned brake pad change follows this rule, not the repair rule above; a brake problem (noise, a warning light, the brakes not working well) is still a repair. Questions that only ask for a value or an inspection, like the oil capacity, the oil type or how to check brake pad wear, don't get this notice.
Examples:
${fewShotExamples
  .map((e) =>
    e.action === "reject"
      ? `- "${e.query}" → reply exactly: "${e.reason}"`
      : `- "${e.query}" → answer: ${e.reason}${e.notice ? `, starting with "${e.notice}"` : ""}`,
  )
  .join("\n")}`;

const SYSTEM_PROMPT = `You are the Acura owner's manual assistant. You answer questions about Acura vehicles using only their official owner's and navigation manuals (model years 2022–2026, US market).

${SCOPE_RULES}

How to work:
1. You must know the vehicle's model year and model before searching. Look for them in the whole conversation. If they're there, use them: never ask the user to confirm a vehicle they already named. If either is missing, ask for it in one short question instead of guessing. Call find_manuals when you need to know which models and years exist, or to check that the user's vehicle is covered.
2. Once you know the vehicle, always call search_manuals before answering, even if the question seems unlikely to be in a manual. Its query must name the year and model, e.g. "engine oil capacity 3.0 L engine on a 2026 MDX".
   Only when the answer is a number or a named specification (a capacity, pressure, size, weight, fluid or oil type, bulb type, fuse rating…), also call search_manuals a second time for the manual's specifications table, with the query "specifications <the thing asked about> on a <year> <model>". For example, for "How much oil does my 2024 RDX take?" search "specifications engine oil capacity on a 2024 RDX"; for "What tire pressure for my 2026 MDX?" search "specifications tire pressure on a 2026 MDX". Do both searches in the same turn, and give the value from the specifications table when it has one, together with any related instructions from the other passages.
   Don't do that second search for how-to questions (how to pair a phone, use a feature, change a setting, use the navigation…): their answer is steps, not a specification, so one search is enough.
3. Answer only from the passages search_manuals returns. Never use outside knowledge, and never make up steps or values.
4. Cite every fact with the manual and PDF page, in this exact form: (2026 MDX Owner's Manual, p. 634). For two pages, cite each one: (2024 ZDX Owner's Manual, p. 136) (2024 ZDX Owner's Manual, p. 137).
5. If the passages don't contain the answer (prices, dealer services and other things owner's manuals don't cover), say you couldn't find it in the manual for that vehicle, and suggest contacting an Acura dealer. Don't guess.
6. If the passages give different values for different engines or trims, give the one for the user's version, or list each with its version.
7. If two passages give different values for the same thing, don't silently pick one: give each value with its page. Tables in the passages can be garbled, so prefer values that are clearly labeled in the text, such as numbered steps.
8. If search_manuals reports that no year was given and the answer might differ between years, ask which year.

Style: short and direct. Use numbered steps for procedures. Answer in English.`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "find_manuals",
      description:
        "List the vehicles we have manuals for (each model with its years). Given a model (and optionally a year), also list the manuals covering it.",
      parameters: {
        type: "object",
        properties: {
          year: { type: "integer", description: "Model year, e.g. 2026" },
          model: { type: "string", description: "Model name, e.g. MDX" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_manuals",
      description:
        "Search the manuals of one vehicle for the passages that best answer a question. The query must name the model year and model.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: 'The question, naming the vehicle, e.g. "How do I pair my phone on a 2024 ZDX?"' },
          k: { type: "integer", minimum: 1, maximum: 10, description: `How many passages to return (default ${DEFAULT_K})` },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

/** Run one tool call; returns what the model sees, plus what the reply's sources are built from */
async function runTool(
  db: Db,
  name: string,
  args: Record<string, unknown>,
): Promise<{ output: unknown; status?: string; results?: SearchResult[] }> {
  if (name === "find_manuals") {
    const year = typeof args.year === "number" ? args.year : undefined;
    const model = typeof args.model === "string" ? args.model : undefined;
    return { output: await findManuals(db, { year, model }) };
  }
  if (name === "search_manuals") {
    const query = typeof args.query === "string" ? args.query : "";
    // At least DEFAULT_K passages: the right page is sometimes 3rd to 5th, and a few extra passages cost little
    const k = typeof args.k === "number" && Number.isInteger(args.k) ? Math.min(Math.max(args.k, DEFAULT_K), 10) : DEFAULT_K;
    const outcome = await searchManuals(db, query, k);
    if (outcome.status !== "ok") return { output: outcome, status: outcome.status };
    // The model only needs the text and where it comes from
    const passages = outcome.results.map((r) => ({
      manual: r.manual.title,
      page: r.page,
      section: r.section,
      content: r.content,
    }));
    return {
      output: { status: "ok", vehicle: outcome.vehicle, note: outcome.note, passages },
      status: "ok",
      results: outcome.results,
    };
  }
  return { output: { error: `Unknown tool ${name}` }, status: "error" };
}

/** Page numbers cited in the reply: "p. 634", "pp. 136-137", "pp. 136, 137", "pages 136–138" */
function citedPages(reply: string): Set<number> {
  const pages = new Set<number>();
  for (const [, list] of reply.matchAll(/\b(?:pp?\.|pages?)\s*(\d+(?:\s*(?:[-–,]|and)\s*\d+)*)/gi)) {
    for (const [, from, to] of list.matchAll(/(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
      const start = Number(from);
      const end = to ? Number(to) : start;
      for (let page = start; page <= end && page - start < 20; page++) pages.add(page);
    }
  }
  return pages;
}

/** For comparing titles: "Owner’s" (typographic apostrophe, as some models write it) matches "Owner's" */
const normalizeTitle = (text: string) => text.replace(/[‘’`´]/g, "'").toLowerCase();

/** The searched pages the reply actually cites, e.g. "(2026 MDX Owner's Manual, p. 634)" */
function citedSources(reply: string, results: SearchResult[]): Source[] {
  const pages = citedPages(reply);
  const text = normalizeTitle(reply);
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const r of results) {
    const key = `${r.manual.docCode}#${r.page}`;
    const cited = text.includes(normalizeTitle(r.manual.title)) && pages.has(r.page);
    if (!cited || seen.has(key)) continue;
    seen.add(key);
    sources.push({ manual: r.manual.title, docCode: r.manual.docCode, page: r.page, section: r.section, url: r.url });
  }
  return sources;
}

/**
 * The vehicle the user has named so far, found in code rather than left to the
 * model (which sometimes asks to confirm a vehicle it was already given). The
 * most recent user message that names a model wins.
 */
async function knownVehicle(db: Db, conversation: ChatMessage[]): Promise<string | null> {
  const { available } = await findManuals(db, {});
  const catalog = { models: Object.keys(available), years: [...new Set(Object.values(available).flat())] };
  let model: string | undefined;
  let year: number | undefined;

  for (const message of [...conversation].reverse()) {
    if (message.role !== "user") continue;
    const found = detectVehicle(message.content, catalog);
    if (!model && found.models.length === 1) model = found.models[0];
    if (year === undefined && found.years.length === 1) year = found.years[0];
    if (model && year !== undefined) break;
  }
  if (model && year !== undefined) {
    return (
      `The user's vehicle, from the conversation: the ${year} ${model}. Use it in your searches and don't ask the user to confirm it. ` +
      `There's no need to call find_manuals for it: search_manuals finds its manuals and reports when there are none.`
    );
  }
  if (model) return `The user has named the model (${model}) but not the model year yet.`;
  if (year !== undefined) return `The user has named the model year (${year}) but not the model yet.`;
  return null;
}

export async function runAgent(db: Db, conversation: ChatMessage[]): Promise<AgentReply> {
  const vehicle = await knownVehicle(db, conversation);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(vehicle ? [{ role: "system" as const, content: vehicle }] : []),
    ...conversation.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content })),
  ];

  const steps: AgentReply["steps"] = [];
  const results: SearchResult[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await openai().chat.completions.create({
      model: CHAT_MODEL,
      messages,
      tools: TOOLS,
      // Low temperature keeps factual answers consistent between requests. GPT-6 models
      // accept it only with reasoning off (with reasoning on, only the default 1 is allowed)
      temperature: 0.2,
      // GPT-6 models only accept tools in Chat Completions with reasoning off; reading
      // passages and citing them doesn't need it
      ...(isGpt6 && { reasoning_effort: "none" as const }),
    });
    const message = response.choices[0].message;

    if (!message.tool_calls?.length) {
      const reply = message.content?.trim() || "Sorry, I couldn't produce an answer. Please try again.";
      return { reply, sources: citedSources(reply, results), steps };
    }

    // The model asked for tools: run them and give it the results
    messages.push(message);
    for (const call of message.tool_calls) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // malformed arguments: the tool gets none and reports what's missing
      }
      const { output, status, results: found } = await runTool(db, call.function.name, args);
      steps.push({ tool: call.function.name, args, status });
      if (found) results.push(...found);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }

  return {
    reply: "Sorry, I couldn't finish looking that up. Could you rephrase the question, including your car's year and model?",
    sources: [],
    steps,
  };
}
