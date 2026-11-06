// The two manual tools, shared by the assistant (agents/manual-assistant.ts)
// and the MCP server for external agents (mcp-server/server.ts), so both get the same
// arguments, limits and output:
//   - find_manuals:   which vehicles and manuals we have
//   - search_manuals: the passages of one vehicle's manuals closest to a question

import { z } from "zod";
import type { Db } from "./config.ts";
import { findManuals, searchManuals, type SearchResult } from "./search.ts";

export const DEFAULT_K = 5;
const MAX_K = 10;

export const FIND_MANUALS_DESCRIPTION =
  "List the vehicles we have manuals for (each model with its years). Given a model (and optionally a year), also list the manuals covering it.";
export const SEARCH_MANUALS_DESCRIPTION =
  "Search the manuals of one vehicle for the passages that best answer a question. The query must name the model year and model.";

// The tools' arguments. null means "not given": the assistant's tools are in
// OpenAI's strict mode, where every field is required.
export const FindManualsArgs = z.object({
  year: z.int().nullable().describe("Model year, e.g. 2026, or null for every year"),
  model: z.string().nullable().describe("Model name, e.g. MDX, or null for every model"),
});

export const SearchManualsArgs = z.object({
  query: z.string().describe('The question, naming the vehicle, e.g. "How do I pair my phone on a 2024 ZDX?"'),
  k: z.int().min(1).max(MAX_K).nullable().describe(`How many passages to return, or null for the default (${DEFAULT_K})`),
});

/** What a tool returns: the output its caller sees, plus the full results the assistant builds its sources from */
export type ToolResult = { output: unknown; status?: string; results?: SearchResult[] };

export async function runFindManuals(db: Db, args: z.infer<typeof FindManualsArgs>): Promise<ToolResult> {
  return { output: await findManuals(db, { year: args.year ?? undefined, model: args.model ?? undefined }) };
}

export async function runSearchManuals(db: Db, args: z.infer<typeof SearchManualsArgs>): Promise<ToolResult> {
  // At least DEFAULT_K passages: the right page is sometimes 3rd to 5th, and a few extra passages cost little
  const k = Math.max(args.k ?? DEFAULT_K, DEFAULT_K);
  const outcome = await searchManuals(db, args.query, k);
  if (outcome.status !== "ok") return { output: outcome, status: outcome.status };
  // The caller only needs the text and where it comes from
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
