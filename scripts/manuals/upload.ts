/**
 * Uploader: embeds each manual's chunks and stores them in the `chunks` table.
 *
 * Reads data/chunks/<doc_code>.jsonl (written by `npm run manuals:chunk`),
 * embeds every chunk's embeddingText() with text-embedding-3-small, then in
 * one transaction per manual: deletes the manual's old chunks, inserts the new
 * ones, and sets manuals.page_count and manuals.ingested_at. A manual is
 * therefore either fully replaced or left as it was — re-running never
 * leaves duplicates or a half-uploaded manual.
 *
 * Without arguments, only manuals not uploaded yet (ingested_at is empty)
 * are processed, so an interrupted run can simply be started again.
 *
 * Usage:
 *   npm run manuals:upload                          # manuals not uploaded yet
 *   npm run manuals:upload -- BTYA2626OMEN          # only these (re-uploads them)
 *   npm run manuals:upload -- --force               # every manual, again
 *   npm run manuals:upload -- --dry-run             # show what would happen; no API calls or writes
 */

import * as mupdf from "mupdf";
import { existsSync, readFileSync } from "fs";
import { createEmbeddings, EMBEDDING_DIMENSIONS } from "../../lib/openai.ts";
import { db } from "../../src/prisma/db.ts";
import { embeddingText, manualPdfPath, readChunkFile, type Chunk } from "./chunk-file.ts";

const BATCH_SIZE = 100; // chunks per embedding request and per insert
const CONCURRENCY = 4; // embedding requests in flight at once
const MAX_ATTEMPTS = 5; // per embedding request, with exponential backoff
const PRICE_PER_MILLION_TOKENS = 0.02; // text-embedding-3-small, for the cost estimate

/** Embed one batch, retrying on rate limits and transient errors */
async function embedBatch(texts: string[]): Promise<number[][]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const vectors = await createEmbeddings(texts);
      if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(`Expected ${texts.length} vectors of ${EMBEDDING_DIMENSIONS} dimensions`);
      }
      return vectors;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      const wait = 1000 * 2 ** (attempt - 1);
      console.warn(`  Embedding request failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${wait / 1000}s: ${err}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** Embed all chunks, CONCURRENCY batches at a time, keeping their order */
async function embedAll(chunks: Chunk[]): Promise<number[][]> {
  const batches: Chunk[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) batches.push(chunks.slice(i, i + BATCH_SIZE));

  const vectors: number[][][] = new Array(batches.length);
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const wave = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(wave.map((batch) => embedBatch(batch.map(embeddingText))));
    results.forEach((result, j) => (vectors[i + j] = result));
  }
  return vectors.flat();
}

function countPdfPages(path: string): number | null {
  if (!existsSync(path)) return null;
  const doc = mupdf.Document.openDocument(readFileSync(path), "application/pdf");
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const codes = args.filter((a) => !a.startsWith("--"));

  const all = [...(await db.orm.public.Manual.all())].sort((a, b) => a.year - b.year || a.docCode.localeCompare(b.docCode));
  const unknown = codes.filter((c) => !all.some((m) => m.docCode === c));
  if (unknown.length > 0) {
    console.error(`Unknown doc_code(s): ${unknown.join(", ")} — run "npm run db:seed" first?`);
    process.exit(1);
  }
  const manuals =
    codes.length > 0 ? all.filter((m) => codes.includes(m.docCode)) : all.filter((m) => force || !m.ingestedAt);
  if (manuals.length === 0) {
    console.log("Every manual is already uploaded — pass doc codes or --force to upload again");
    return;
  }

  let totalChunks = 0;
  let totalTokens = 0;
  for (const manual of manuals) {
    const chunks = readChunkFile(manual.docCode);
    if (!chunks || chunks.length === 0) {
      console.warn(`${manual.docCode}: no chunk file — run "npm run manuals:chunk -- ${manual.docCode}" first; skipped`);
      continue;
    }
    const tokens = chunks.reduce((n, c) => n + c.tokens, 0);
    const pageCount = countPdfPages(manualPdfPath(manual.year, manual.docCode));
    const label = `${manual.docCode.padEnd(13)} ${String(chunks.length).padStart(4)} chunks, ~${tokens} tokens`;
    if (dryRun) {
      console.log(`${label} (dry run: nothing embedded or written)`);
      totalChunks += chunks.length;
      totalTokens += tokens;
      continue;
    }

    const started = Date.now();
    const vectors = await embedAll(chunks);

    // Replace the manual's chunks in one transaction
    const replaced = await db.transaction(async (tx) => {
      const deleted = await tx.orm.public.Chunk.where({ manualId: manual.id }).deleteAndCount();
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const rows = chunks.slice(i, i + BATCH_SIZE).map((chunk, j) => ({
          manualId: manual.id,
          page: chunk.page,
          sectionTitle: chunk.sectionTitle,
          content: chunk.content,
          embedding: vectors[i + j],
        }));
        await tx.orm.public.Chunk.createAndCount(rows);
      }
      await tx.orm.public.Manual.where({ id: manual.id }).update({
        pageCount,
        ingestedAt: new Date().toISOString(),
      });
      return deleted;
    });

    totalChunks += chunks.length;
    totalTokens += tokens;
    console.log(`${label} → uploaded (replaced ${replaced} old) [${((Date.now() - started) / 1000).toFixed(1)}s]`);
  }

  const cost = (totalTokens / 1_000_000) * PRICE_PER_MILLION_TOKENS;
  console.log(
    `\n${dryRun ? "Would upload" : "Uploaded"} ${totalChunks} chunks for ${manuals.length} manuals ` +
      `(~${totalTokens} tokens, about $${cost.toFixed(2)})`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
