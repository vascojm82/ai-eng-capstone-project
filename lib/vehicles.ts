// Finds which vehicle a question is about ("…on a 2026 MDX?") by matching the
// model names and years we have manuals for. The catalog is small and known,
// so exact matching is enough: no LLM call, no guessing.

export type Catalog = {
  /** Model names as stored in the vehicles table, e.g. "MDX", "Integra" */
  models: string[];
  /** Model years we have manuals for */
  years: number[];
};

export type DetectedVehicle = {
  /** Every catalog model named in the question (normally zero or one) */
  models: string[];
  /** Every model year named in the question (normally zero or one), even ones we have no manuals for */
  years: number[];
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function detectVehicle(query: string, catalog: Catalog): DetectedVehicle {
  const models = catalog.models.filter((model) => new RegExp(`\\b${escapeRegExp(model)}\\b`, "i").test(query));

  // "2026", or the short form "'26" / "’26"
  const years = new Set<number>();
  for (const match of query.matchAll(/\b(20\d{2})\b/g)) years.add(Number(match[1]));
  for (const match of query.matchAll(/['’](\d{2})\b/g)) years.add(2000 + Number(match[1]));

  return { models, years: [...years].sort() };
}
