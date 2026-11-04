/**
 * Manual updater: finds new and revised manuals on the owner site and
 * replaces only those, end to end (PDF, database rows, chunks, embeddings).
 *
 * `npm run manuals:check` changes nothing in the database or in raw/:
 *   1. runs fetch_manuals.py for each year into data/acura_manuals/staging/,
 *      which writes fresh manifests and downloads the PDFs. A PDF whose
 *      server headers (size, last modified) match the ones stored in the
 *      database isn't downloaded again.
 *   2. hashes each downloaded PDF and compares it with manuals.sha256:
 *      new doc code = new manual, different hash = revised manual.
 *   3. validates every new or revised PDF: it opens, has a sensible page
 *      count, and chunks into a similar number of chunks as its previous
 *      version (or the closest year's manual of the same model). The
 *      chunks go to staging/chunks/.
 *   4. writes staging/plan.json and prints a report.
 *
 * `npm run manuals:update` applies the last check (running one first when
 * it's missing or older than MAX_PLAN_AGE_DAYS), but only when it found no
 * problems:
 *   1. moves replaced PDFs to data/acura_manuals/archive/<date>/, puts the
 *      new ones in raw/ and copies the new manifests;
 *   2. runs the seed (which marks revised manuals for re-upload), stores
 *      the server headers, copies the chunk files and runs the upload,
 *      which replaces each manual's chunks in one transaction;
 *   3. deletes staging/. If it stops halfway, run it again: it resumes.
 *
 * Usage:
 *   npm run manuals:check                          # years in the database, plus any newer ones up to next year
 *   npm run manuals:check -- --years 2026 2027     # only these years
 *   npm run manuals:update                         # apply the last check
 *   npm run manuals:update -- --dry-run            # same as manuals:check
 */

import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { db } from "../../src/prisma/db.ts";
import { chunkFilePath, CHUNKS_DIR, MANUALS_DIR, manualPdfPath } from "./chunk-file.ts";
import { chunkManual } from "./chunk.ts";
import { docCodeFromUrl, isPdfRow, readManifest, sha256, splitEdition, type ManifestRow } from "./manifest.ts";

const STAGING_DIR = join(MANUALS_DIR, "staging");
const ARCHIVE_DIR = join(MANUALS_DIR, "archive");
const PLAN_PATH = join(STAGING_DIR, "plan.json");
const FETCH_SCRIPT = join(MANUALS_DIR, "fetch_manuals.py");
const PYTHON = process.env.PYTHON ?? "python3"; // needs requests and certifi
const MAX_PLAN_AGE_DAYS = 3; // an older check is run again before applying
const MIN_PAGES = 20; // fewer pages is a broken or wrong download (the smallest manual has 90)
const MAX_CHUNK_CHANGE = 0.3; // chunk count may differ this much from the previous version

type Status = "new" | "revised" | "unchanged" | "failed";

type PlanManual = {
  docCode: string;
  year: number;
  title: string;
  status: Status;
  /** Server headers, stored in the database on apply (null when the server didn't send them) */
  size: number | null;
  lastModified: string | null;
  /** Only for new and revised manuals */
  pages?: number;
  chunks?: number;
  family?: string;
  /** Chunk count of the previous version, or of the closest year's manual for a new one */
  compareChunks?: number;
  compareWith?: string;
  problem?: string;
};

type Plan = {
  checkedAt: string;
  years: number[];
  manuals: PlanManual[];
  /** Years whose manifest gained or lost rows (trims), e.g. "2026: +2 −0 rows" */
  manifestChanges: string[];
  /** Manuals in the database for a checked year that the site no longer lists (kept) */
  notListed: string[];
  /** Problems that aren't about a single manual */
  problems: string[];
  /** Set once the files are in place; a rerun then resumes with the database steps */
  appliedAt?: string;
};

type Download = { status: "downloaded" | "kept" | "unchanged" | "failed"; size: number | null; last_modified: string | null; error?: string };

const stagedYearDir = (year: number) => join(STAGING_DIR, `manuals_${year}`);
const stagedPdfPath = (year: number, docCode: string) => join(stagedYearDir(year), "raw", `${docCode}.PDF`);
const stagedChunkPath = (docCode: string) => join(STAGING_DIR, "chunks", `${docCode}.jsonl`);
const liveYearDir = (year: number) => join(MANUALS_DIR, `manuals_${year}`);

/** "2027 MDX Owner's Manual" -> "MDX Owner's Manual", to find another year's manual of the same model */
const titleWithoutYear = (title: string) => title.replace(/^\d{4}\s+/, "");

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
}

function readPlan(): Plan | null {
  return existsSync(PLAN_PATH) ? JSON.parse(readFileSync(PLAN_PATH, "utf-8")) : null;
}

function savePlan(plan: Plan) {
  writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2));
}

/** Manifest rows as comparable strings, ignoring the file column (local paths) */
function manifestKeys(rows: ManifestRow[]): Set<string> {
  return new Set(rows.map((r) => [r.year, r.model, r.trim, r.model_id, r.title, r.url].join("|")));
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

async function check(yearsArg: number[]): Promise<Plan> {
  const inDb = [...(await db.orm.public.Manual.all())];
  const byCode = new Map(inDb.map((m) => [m.docCode, m]));
  const chunkCounts = new Map(
    (await db.orm.public.Chunk.groupBy("manualId").aggregate((agg) => ({ count: agg.count() }))).map((r) => [
      r.manualId,
      Number(r.count),
    ]),
  );
  // By default: the years in the database, plus every year after the newest one
  // up to next year's models (so a skipped year, e.g. 2027 when checking in 2028, isn't missed)
  const dbYears = [...new Set(inDb.map((m) => m.year))].sort();
  if (dbYears.length === 0 && yearsArg.length === 0) {
    throw new Error("The database has no manuals yet: name the years to check, e.g. --years 2025 2026");
  }
  const nextYear = new Date().getFullYear() + 1;
  const newer: number[] = [];
  for (let y = Math.max(...dbYears) + 1; y <= nextYear; y++) newer.push(y);
  const years = yearsArg.length > 0 ? yearsArg : [...dbYears, ...newer];

  // 1. Manifests and PDFs into a fresh staging folder
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });
  const knownPath = join(STAGING_DIR, "known.json");
  const known = Object.fromEntries(
    inDb
      .filter((m) => m.sourceSize !== null && m.sourceLastModified !== null)
      .map((m) => [`${m.docCode}.PDF`, { size: m.sourceSize, last_modified: m.sourceLastModified }]),
  );
  writeFileSync(knownPath, JSON.stringify(known));
  console.log(`Checking ${years.join(", ")} on the owner site (downloads go to ${STAGING_DIR}/)…\n`);
  try {
    run(PYTHON, [FETCH_SCRIPT, "--years", ...years.map(String), "--root", STAGING_DIR, "--known", knownPath]);
  } catch (err) {
    throw new Error(
      `fetch_manuals.py failed (${(err as Error).message}). If the owner site is down, try again later. ` +
        `If Python is missing requests or certifi, set PYTHON to a Python that has them, e.g. PYTHON=/opt/anaconda3/bin/python3`,
    );
  }

  const plan: Plan = { checkedAt: new Date().toISOString(), years, manuals: [], manifestChanges: [], notListed: [], problems: [] };
  const listed = new Set<string>();

  for (const year of years) {
    const manifestPath = join(stagedYearDir(year), "manifest.csv");
    const rows = existsSync(manifestPath) ? readManifest(manifestPath) : [];
    const pdfRows = rows.filter(isPdfRow);
    const inDbForYear = inDb.filter((m) => m.year === year);

    if (pdfRows.length === 0) {
      if (inDbForYear.length > 0) {
        plan.problems.push(
          `The site listed no ${year} manuals, but the database has ${inDbForYear.length}; the site may have changed`,
        );
        inDbForYear.forEach((m) => listed.add(m.docCode)); // not reported as unlisted on top of that
      }
      continue;
    }

    // Manifest rows added or removed (trims), compared with the committed manifest
    const livePath = join(liveYearDir(year), "manifest.csv");
    const before = existsSync(livePath) ? manifestKeys(readManifest(livePath)) : new Set<string>();
    const after = manifestKeys(rows);
    const added = [...after].filter((k) => !before.has(k)).length;
    const removed = [...before].filter((k) => !after.has(k)).length;
    if (before.size === 0) plan.manifestChanges.push(`${year}: new (${rows.length} rows)`);
    else if (added + removed > 0) plan.manifestChanges.push(`${year}: +${added} −${removed} rows`);

    const downloadsPath = join(stagedYearDir(year), "downloads.json");
    const downloads: Record<string, Download> = existsSync(downloadsPath)
      ? JSON.parse(readFileSync(downloadsPath, "utf-8"))
      : {};

    const seen = new Set<string>();
    for (const row of pdfRows) {
      const docCode = docCodeFromUrl(row.url);
      if (seen.has(docCode)) continue;
      seen.add(docCode);
      listed.add(docCode);

      const old = byCode.get(docCode);
      const title = splitEdition(row.title).title;
      const download = Object.entries(downloads).find(([name]) => name.toUpperCase() === `${docCode}.PDF`)?.[1];
      const item: PlanManual = {
        docCode,
        year,
        title,
        status: "unchanged",
        size: download?.size ?? null,
        lastModified: download?.last_modified ?? null,
      };
      plan.manuals.push(item);

      if (!download || download.status === "failed") {
        item.status = "failed";
        item.problem = `download failed (${download?.error ?? "not attempted"})`;
        continue;
      }
      if (download.status === "unchanged") continue; // same size and date on the server

      // 2. Compare fingerprints
      const pdfPath = stagedPdfPath(year, docCode);
      const hash = await sha256(pdfPath);
      if (old?.sha256 === hash) continue;
      item.status = old ? "revised" : "new";

      // 3. Validate: open and chunk it, then compare with the previous version
      try {
        const { chunks, stats } = chunkManual(docCode, title, pdfPath);
        mkdirSync(join(STAGING_DIR, "chunks"), { recursive: true });
        writeFileSync(stagedChunkPath(docCode), chunks.map((c) => JSON.stringify(c)).join("\n") + "\n");
        Object.assign(item, { pages: stats.pages, chunks: stats.chunks, family: stats.family });
      } catch (err) {
        item.problem = `can't be read as a PDF (${(err as Error).message})`;
        continue;
      }

      // A new manual is compared with the closest year's manual of the same model and kind
      // (an earlier one when two are equally close)
      const previous =
        old ??
        inDb
          .filter((m) => titleWithoutYear(m.title) === titleWithoutYear(title))
          .sort((a, b) => Math.abs(a.year - year) - Math.abs(b.year - year) || a.year - b.year)[0];
      const compareChunks = previous ? chunkCounts.get(previous.id) : undefined;
      if (previous && compareChunks) {
        item.compareChunks = compareChunks;
        item.compareWith = previous.docCode;
      }

      if ((item.pages ?? 0) < MIN_PAGES) {
        item.problem = `only ${item.pages} pages`;
      } else if (!item.chunks) {
        item.problem = "no chunks: the chunker couldn't read its layout";
      } else if (compareChunks && Math.abs(item.chunks - compareChunks) / compareChunks > MAX_CHUNK_CHANGE) {
        const change = Math.round(((item.chunks - compareChunks) / compareChunks) * 100);
        item.problem =
          `${item.chunks} chunks vs ${compareChunks} for ${item.compareWith} (${change > 0 ? "+" : ""}${change}%): ` +
          `check its layout (see "Updating the manuals" in the README)`;
      }
    }
  }

  plan.notListed = inDb
    .filter((m) => years.includes(m.year) && !listed.has(m.docCode))
    .map((m) => `${m.docCode} (${m.title})`);

  savePlan(plan);
  return plan;
}

const problemsOf = (plan: Plan) => [
  ...plan.problems,
  ...plan.manuals.filter((m) => m.problem).map((m) => `${m.docCode.padEnd(13)} ${m.problem}`),
];

function report(plan: Plan) {
  const line = (m: PlanManual) => {
    const compare = m.compareChunks ? ` (${m.compareWith}: ${m.compareChunks})` : "";
    const details = m.chunks !== undefined ? `  ${m.pages} pages → ${m.chunks} chunks${compare}, ${m.family} layout` : "";
    return `    ${m.docCode.padEnd(13)} ${m.title}${details}`;
  };
  const group = (status: Status, label: string) => {
    const items = plan.manuals.filter((m) => m.status === status && !m.problem);
    console.log(`${label.padEnd(11)}${items.length}`);
    if (status !== "unchanged") items.forEach((m) => console.log(line(m)));
  };

  console.log(`\nChecked ${plan.years.join(", ")}: ${plan.manuals.length} manuals listed`);
  group("new", "New");
  group("revised", "Revised");
  group("unchanged", "Unchanged");
  if (plan.notListed.length > 0) {
    console.log(`No longer listed (kept in the database): ${plan.notListed.join(", ")}`);
  }
  if (plan.manifestChanges.length > 0) console.log(`Manifest changes: ${plan.manifestChanges.join("; ")}`);

  const problems = problemsOf(plan);
  if (problems.length > 0) {
    console.log(`\nProblems   ${problems.length}`);
    problems.forEach((p) => console.log(`    ${p}`));
    console.log(`\nNothing can be applied until these are fixed. Then run "npm run manuals:check" again.`);
    return;
  }
  const changed = plan.manuals.filter((m) => m.status === "new" || m.status === "revised");
  if (changed.length === 0 && plan.manifestChanges.length === 0) {
    console.log("\nEverything is up to date.");
  } else {
    console.log(`\nRun "npm run manuals:update" to apply.`);
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

async function update(yearsArg: number[]) {
  let plan = readPlan();
  if (plan?.appliedAt) {
    console.log(`Resuming the update applied at ${plan.appliedAt}…`);
    return finish(plan);
  }

  const ageDays = plan ? (Date.now() - Date.parse(plan.checkedAt)) / 86_400_000 : Infinity;
  const sameYears = yearsArg.length === 0 || (plan && yearsArg.join() === plan.years.join());
  if (!plan || ageDays > MAX_PLAN_AGE_DAYS || !sameYears) {
    console.log(plan ? "The last check is out of date; checking again.\n" : "No check found; checking first.\n");
    plan = await check(yearsArg);
    report(plan);
  } else {
    console.log(`Using the check from ${plan.checkedAt}`);
    report(plan);
  }
  if (problemsOf(plan).length > 0) {
    process.exitCode = 1;
    return;
  }

  const changed = plan.manuals.filter((m) => m.status === "new" || m.status === "revised");
  if (changed.length === 0 && plan.manifestChanges.length === 0) {
    await storeHeaders(plan); // still worth keeping, so the next check skips more downloads
    rmSync(STAGING_DIR, { recursive: true, force: true });
    return;
  }

  // 1. Files: archive the replaced PDFs, then move the new ones and the manifests into place
  const archive = join(ARCHIVE_DIR, plan.checkedAt.slice(0, 10));
  for (const m of changed) {
    const live = manualPdfPath(m.year, m.docCode);
    if (m.status === "revised" && existsSync(live)) {
      mkdirSync(join(archive, `manuals_${m.year}`), { recursive: true });
      renameSync(live, join(archive, `manuals_${m.year}`, `${m.docCode}.PDF`));
    }
    mkdirSync(join(liveYearDir(m.year), "raw"), { recursive: true });
    renameSync(stagedPdfPath(m.year, m.docCode), live);
  }
  const years = plan.years.filter((y) => plan.manuals.some((m) => m.year === y));
  for (const year of years) {
    mkdirSync(liveYearDir(year), { recursive: true });
    copyFileSync(join(stagedYearDir(year), "manifest.csv"), join(liveYearDir(year), "manifest.csv"));
  }
  // by_trim/, MAPPING.txt and the manifests' file column, from the manuals now in raw/
  run(PYTHON, [FETCH_SCRIPT, "--years", ...years.map(String), "--root", MANUALS_DIR, "--links-only"]);
  if (changed.some((m) => m.status === "revised")) console.log(`Replaced PDFs archived in ${archive}/`);

  plan.appliedAt = new Date().toISOString();
  savePlan(plan);
  await finish(plan);
}

/** Store the server headers of every manual the check saw, for the next check */
async function storeHeaders(plan: Plan) {
  for (const m of plan.manuals) {
    if (m.size === null || m.lastModified === null) continue;
    await db.orm.public.Manual.where({ docCode: m.docCode }).update({ sourceSize: m.size, sourceLastModified: m.lastModified });
  }
}

/** The database steps; safe to run again after a failure */
async function finish(plan: Plan) {
  const changed = plan.manuals.filter((m) => m.status === "new" || m.status === "revised");

  // 2. Rows: the seed adds new manuals and trims, and marks revised manuals for upload
  run("npm", ["run", "db:seed"]);
  await storeHeaders(plan);

  // 3. Chunks and embeddings: upload without arguments takes every manual not uploaded yet
  mkdirSync(CHUNKS_DIR, { recursive: true });
  for (const m of changed) {
    if (existsSync(stagedChunkPath(m.docCode))) copyFileSync(stagedChunkPath(m.docCode), chunkFilePath(m.docCode));
  }
  run("npm", ["run", "manuals:upload"]);

  rmSync(STAGING_DIR, { recursive: true, force: true });

  console.log(`\nUpdate done: ${changed.length} manuals added or replaced.`);
  console.log("Next:");
  console.log("  - npm run evals, to check the assistant still answers as expected");
  console.log("  - commit the changed manifests in data/acura_manuals/ (git status)");
  // The agent reads the years from the database (refreshed every 10 minutes), but the
  // eval for a year without manuals asks about a fixed year
  const newYears = plan.years.filter((y) => {
    const ofYear = plan.manuals.filter((m) => m.year === y);
    return ofYear.length > 0 && ofYear.every((m) => m.status === "new");
  });
  if (newYears.length > 0) {
    console.log(
      `  - new model year ${newYears.join(", ")}: if the "unknown year" eval case in lib/evals/chat.test.ts ` +
        `asks about it, move it to a year without manuals`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const yearsAt = args.indexOf("--years");
  const years = yearsAt >= 0 ? args.slice(yearsAt + 1).filter((a) => /^\d{4}$/.test(a)).map(Number) : [];
  if (yearsAt >= 0 && years.length === 0) throw new Error("--years needs at least one year, e.g. --years 2026 2027");

  if (args.includes("--check") || args.includes("--dry-run")) {
    report(await check(years));
  } else {
    await update(years);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
