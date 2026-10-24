// Manual search: works out the vehicle from the question, picks that
// vehicle's manuals in SQL, then runs the vector search only inside them, so
// results never mix up vehicles. Used by POST /search, and meant to be the
// search tool of the agent later.

import type { Db } from "./config.ts";
import { createEmbedding } from "./openai.ts";
import { detectVehicle, type Catalog } from "./vehicles.ts";

export type ManualRef = { docCode: string; title: string; type: string; year: number };

export type SearchResult = {
  rank: number;
  manual: ManualRef;
  /** 1-based PDF page */
  page: number;
  section: string | null;
  content: string;
  /** Cosine distance to the question: 0 is identical, smaller is closer */
  distance: number;
  /** The PDF, opened at this page */
  url: string;
};

export type SearchOutcome =
  | {
      status: "ok";
      vehicle: { year: number | null; model: string };
      manuals: ManualRef[];
      results: SearchResult[];
      /** Set when the question didn't name a year, so every year of the model was searched */
      note?: string;
    }
  | { status: "needs_vehicle"; missing: ("year" | "model")[]; message: string; available: Record<string, number[]> }
  | { status: "no_manuals"; message: string; available: Record<string, number[]> };

// ---------------------------------------------------------------------------
// Catalog: which vehicles exist and which manuals cover them. The tables are
// small (135 vehicles, 37 manuals), so they're read once and kept in memory
// for a few minutes instead of being queried on every search.
// ---------------------------------------------------------------------------

type ManualRow = ManualRef & { id: number; sourceUrl: string };
type Snapshot = {
  catalog: Catalog;
  /** model -> its years, e.g. { MDX: [2022, …, 2026] } */
  yearsByModel: Record<string, number[]>;
  vehicles: { id: number; model: string; year: number }[];
  manualIdsByVehicle: Map<number, number[]>;
  manuals: Map<number, ManualRow>;
  loadedAt: number;
};

const CATALOG_TTL_MS = 10 * 60 * 1000;
let snapshot: Snapshot | null = null;

async function loadSnapshot(db: Db): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < CATALOG_TTL_MS) return snapshot;

  const [vehicles, links, manuals] = await Promise.all([
    db.orm.public.Vehicle.select("id", "model", "year").all(),
    db.orm.public.VehicleManual.all(),
    db.orm.public.Manual.select("id", "docCode", "title", "manualType", "year", "sourceUrl").all(),
  ]);

  const manualIdsByVehicle = new Map<number, number[]>();
  for (const link of links) manualIdsByVehicle.set(link.vehicleId, [...(manualIdsByVehicle.get(link.vehicleId) ?? []), link.manualId]);

  const yearsByModel: Record<string, number[]> = {};
  for (const v of vehicles) yearsByModel[v.model] = [...new Set([...(yearsByModel[v.model] ?? []), v.year])].sort();

  snapshot = {
    catalog: { models: Object.keys(yearsByModel).sort(), years: [...new Set(vehicles.map((v) => v.year))].sort() },
    yearsByModel,
    vehicles: [...vehicles],
    manualIdsByVehicle,
    manuals: new Map(
      [...manuals].map((m) => [
        m.id,
        { id: m.id, docCode: m.docCode, title: m.title, type: m.manualType, year: m.year, sourceUrl: m.sourceUrl },
      ]),
    ),
    loadedAt: Date.now(),
  };
  return snapshot;
}

/** The years we have for each model, optionally only one year's models */
function available(s: Snapshot, year?: number): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(s.yearsByModel)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, years]) => year === undefined || years.includes(year))
      .map(([model, years]) => [model, years]),
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / Math.sqrt(na * nb);
}

export async function searchManuals(db: Db, query: string, k: number): Promise<SearchOutcome> {
  const s = await loadSnapshot(db);
  const detected = detectVehicle(query, s.catalog);

  // 1. Which vehicle? Exactly one model is required; the year is optional.
  if (detected.models.length > 1 || detected.years.length > 1) {
    const named = [...detected.years, ...detected.models].join(", ");
    return {
      status: "needs_vehicle",
      missing: detected.models.length > 1 ? ["model"] : ["year"],
      message: `The question names more than one vehicle (${named}). Ask about one model year and model at a time.`,
      available: available(s),
    };
  }
  const [model] = detected.models;
  const [year] = detected.years;
  if (!model) {
    const forYear = year !== undefined && s.catalog.years.includes(year) ? year : undefined;
    return {
      status: "needs_vehicle",
      missing: year === undefined ? ["year", "model"] : ["model"],
      message:
        forYear !== undefined
          ? `Which ${forYear} Acura model is it? Include the model in the question, e.g. "on a ${forYear} ${Object.keys(available(s, forYear))[0]}".`
          : `Which vehicle is it? Include the model year and model in the question, e.g. "on a 2026 MDX".`,
      available: available(s, forYear),
    };
  }

  // 2. The manuals covering that model (and year), in SQL
  const vehicles = s.vehicles.filter((v) => v.model === model && (year === undefined || v.year === year));
  const manualIds = [...new Set(vehicles.flatMap((v) => s.manualIdsByVehicle.get(v.id) ?? []))];
  if (manualIds.length === 0) {
    return {
      status: "no_manuals",
      message: `We don't have manuals for a ${year} ${model}. ${model} manuals: ${s.yearsByModel[model].join(", ")}.`,
      available: { [model]: s.yearsByModel[model] },
    };
  }
  const manuals = manualIds.map((id) => s.manuals.get(id)!).sort((a, b) => b.year - a.year || a.type.localeCompare(b.type));

  // 3. Embed the question and find the closest chunks, only inside those manuals
  const vector = await createEmbedding(query);
  const rows = await db.orm.public.Chunk.where((c) => c.manualId.in(manualIds))
    .orderBy((c) => c.embedding.cosineDistance(vector).asc())
    .select("manualId", "page", "sectionTitle", "content", "embedding")
    .limit(k)
    .all();

  const results = [...rows].map((row, i): SearchResult => {
    const manual = s.manuals.get(row.manualId)!;
    return {
      rank: i + 1,
      manual: { docCode: manual.docCode, title: manual.title, type: manual.type, year: manual.year },
      page: row.page,
      section: row.sectionTitle,
      content: row.content,
      distance: Math.round(cosineDistance(vector, row.embedding) * 1000) / 1000,
      url: `${manual.sourceUrl}#page=${row.page}`,
    };
  });

  return {
    status: "ok",
    vehicle: { year: year ?? null, model },
    manuals: manuals.map(({ docCode, title, type, year }) => ({ docCode, title, type, year })),
    results,
    ...(year === undefined && {
      note: `No year in the question, so every ${model} year was searched (${s.yearsByModel[model].join(", ")}). Include the year for results from one manual.`,
    }),
  };
}
