/**
 * Seeder: fills vehicles, manuals and vehicle_manuals from the manifests
 * written by fetch_manuals.py (data/acura_manuals/manuals_<year>/manifest.csv).
 *
 * Each manifest row is one trim + one manual. Many trims share the same PDF,
 * so manuals are keyed by doc_code (the file code in the URL, e.g.
 * BTYA2626OMEN) and inserted once; vehicle_manuals links every trim to it.
 * Everything is upserted on its unique key, so re-running is safe.
 *
 * Usage:
 *   npm run db:seed
 *   npm run db:seed -- <manuals dir>
 */

import { createHash } from "crypto";
import { createReadStream, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { db } from "../../src/prisma/db.ts";

const DEFAULT_DIR = "data/acura_manuals";
const MARKET = "US";
const LANGUAGE = "en-US";

type ManifestRow = {
  year: string;
  model: string;
  trim: string;
  model_id: string;
  title: string;
  file: string;
  url: string;
};

type ManualType = "owner" | "navigation" | "interactive";

/** Minimal CSV parser: handles quoted fields, escaped quotes and commas inside quotes */
function parseCsv(text: string): ManifestRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }

  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])) as ManifestRow);
}

/** File code from the manual URL: .../BTYA2626OMEN.PDF -> BTYA2626OMEN, .../B3S52626IOM/enu/index.HTML -> B3S52626IOM */
function docCodeFromUrl(url: string): string {
  const parts = new URL(url).pathname.split("/");
  const file = parts[parts.length - 1];
  return /^index\./i.test(file) ? parts[parts.length - 3] : file.replace(/\.[^.]+$/, "");
}

function manualTypeFromTitle(title: string): ManualType {
  if (/interactive/i.test(title)) return "interactive";
  if (/navigation/i.test(title)) return "navigation";
  return "owner";
}

/** "2022 MDX Owner's Manual (Revised 2021-12-16)" -> { title: "2022 MDX Owner's Manual", edition: "Revised 2021-12-16" } */
function splitEdition(title: string): { title: string; edition: string | null } {
  const match = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return match ? { title: match[1], edition: match[2] } : { title, edition: null };
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function main() {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const yearDirs = existsSync(dir)
    ? readdirSync(dir).filter((d) => /^manuals_\d{4}$/.test(d)).sort()
    : [];
  if (yearDirs.length === 0) {
    console.error(`No manuals_<year> folders in ${dir} — run fetch_manuals.py first`);
    process.exit(1);
  }

  const rows = yearDirs.flatMap((d) =>
    parseCsv(readFileSync(join(dir, d, "manifest.csv"), "utf-8")).map((row) => ({ ...row, yearDir: d })),
  );
  console.log(`Read ${rows.length} manifest rows from ${yearDirs.length} years`);

  // Manuals first, once per doc_code
  const manualIds = new Map<string, number>();
  for (const row of rows) {
    const docCode = docCodeFromUrl(row.url);
    if (manualIds.has(docCode)) continue;

    const { title, edition } = splitEdition(row.title);
    const format = /\.pdf$/i.test(row.url) ? "pdf" : "html";
    const pdfPath = join(dir, row.yearDir, "raw", `${docCode}.PDF`);
    if (format === "pdf" && !existsSync(pdfPath)) {
      console.warn(`Warning: ${docCode} has no local PDF at ${pdfPath}; seeding it without a hash`);
    }

    const fields = {
      title,
      manualType: manualTypeFromTitle(row.title),
      year: Number(row.year),
      language: LANGUAGE,
      edition,
      format,
      sourceUrl: row.url,
      sha256: format === "pdf" && existsSync(pdfPath) ? await sha256(pdfPath) : null,
    } as const;
    const manual = await db.orm.public.Manual.upsert({
      create: { docCode, ...fields },
      update: fields,
      conflictOn: { docCode },
    });
    manualIds.set(docCode, manual.id);
  }
  console.log(`Upserted ${manualIds.size} manuals`);

  // Then one vehicle per year/model/trim, linked to its manual
  const vehicleIds = new Map<string, number>();
  const links: { vehicleId: number; manualId: number }[] = [];
  for (const row of rows) {
    const key = `${row.year}|${row.model}|${row.trim}`;
    let vehicleId = vehicleIds.get(key);
    if (vehicleId === undefined) {
      const vehicle = await db.orm.public.Vehicle.upsert({
        create: { model: row.model, year: Number(row.year), trim: row.trim, modelCode: row.model_id || null, market: MARKET },
        update: { modelCode: row.model_id || null },
        conflictOn: { year: Number(row.year), model: row.model, trim: row.trim, market: MARKET },
      });
      vehicleId = vehicle.id;
      vehicleIds.set(key, vehicleId);
    }
    links.push({ vehicleId, manualId: manualIds.get(docCodeFromUrl(row.url))! });
  }
  console.log(`Upserted ${vehicleIds.size} vehicles`);

  const added = await db.orm.public.VehicleManual.createAndCount(links, { onConflict: "skip" });
  console.log(`Linked ${links.length} vehicle/manual pairs (${added} new)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
