/**
 * Seeder: fills vehicles, manuals and vehicle_manuals from the manifests
 * written by fetch_manuals.py (data/acura_manuals/manuals_<year>/manifest.csv).
 *
 * Each manifest row is one trim + one manual. Many trims share the same PDF,
 * so manuals are keyed by doc_code (the file code in the URL, e.g.
 * BTYA2626OMEN) and inserted once; vehicle_manuals links every trim to it.
 * Only PDF manuals are seeded: the interactive (HTML) manuals in the
 * manifests are skipped. Everything is upserted on its unique key, so
 * re-running is safe. When a manual's PDF has changed (its hash differs),
 * the old hash is kept in previous_sha256 and ingested_at is cleared, so
 * `npm run manuals:upload` replaces its chunks.
 *
 * Usage:
 *   npm run db:seed
 *   npm run db:seed -- <manuals dir>
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { db } from "../../src/prisma/db.ts";
import { docCodeFromUrl, isPdfRow, readManifest, sha256, splitEdition } from "../manuals/manifest.ts";

const DEFAULT_DIR = "data/acura_manuals";
const MARKET = "US";
const LANGUAGE = "en-US";

type ManualType = "owner" | "navigation";

function manualTypeFromTitle(title: string): ManualType {
  return /navigation/i.test(title) ? "navigation" : "owner";
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

  const allRows = yearDirs.flatMap((d) =>
    readManifest(join(dir, d, "manifest.csv")).map((row) => ({ ...row, yearDir: d })),
  );
  const rows = allRows.filter(isPdfRow);
  console.log(
    `Read ${allRows.length} manifest rows from ${yearDirs.length} years (${allRows.length - rows.length} non-PDF rows skipped)`,
  );

  // Manuals first, once per doc_code
  const oldHashes = new Map(
    [...(await db.orm.public.Manual.select("docCode", "sha256").all())].map((m) => [m.docCode, m.sha256]),
  );
  const manualIds = new Map<string, number>();
  const revised: string[] = [];
  for (const row of rows) {
    const docCode = docCodeFromUrl(row.url);
    if (manualIds.has(docCode)) continue;

    const { title, edition } = splitEdition(row.title);
    const pdfPath = join(dir, row.yearDir, "raw", `${docCode}.PDF`);
    const hasPdf = existsSync(pdfPath);
    if (!hasPdf) {
      console.warn(`Warning: ${docCode} has no local PDF at ${pdfPath}; seeding it without a hash`);
    }

    // A new version of the PDF: keep the old hash and clear ingested_at, so
    // `npm run manuals:upload` replaces the manual's chunks
    const hash = hasPdf ? await sha256(pdfPath) : null;
    const oldHash = oldHashes.get(docCode);
    const isRevision = !!oldHash && !!hash && oldHash !== hash;
    const revision = isRevision ? { previousSha256: oldHash, updatedAt: new Date().toISOString(), ingestedAt: null } : {};
    if (isRevision) revised.push(docCode);

    const fields = {
      title,
      manualType: manualTypeFromTitle(row.title),
      year: Number(row.year),
      language: LANGUAGE,
      edition,
      sourceUrl: row.url,
      sha256: hash,
      ...revision,
    } as const;
    const manual = await db.orm.public.Manual.upsert({
      create: { docCode, ...fields },
      update: fields,
      conflictOn: { docCode },
    });
    manualIds.set(docCode, manual.id);
  }
  console.log(`Upserted ${manualIds.size} manuals`);
  if (revised.length > 0) {
    console.log(`New PDF versions (marked for "npm run manuals:upload"): ${revised.join(", ")}`);
  }

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
