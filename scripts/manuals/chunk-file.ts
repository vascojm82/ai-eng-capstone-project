/**
 * The chunk files that sit between the chunker and the uploader:
 * data/chunks/<doc_code>.jsonl, where each line of the file is one chunk
 * (one page, or one part of a long page) stored as JSON.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const CHUNKS_DIR = "data/chunks";
const MANUALS_DIR = "data/acura_manuals";

/** The local copy of a manual's PDF */
export const manualPdfPath = (year: number, docCode: string) =>
  join(MANUALS_DIR, `manuals_${year}`, "raw", `${docCode}.PDF`);

export type Chunk = {
  docCode: string;
  manualTitle: string;
  /** 1-based PDF page number */
  page: number;
  sectionTitle: string | null;
  content: string;
  tokens: number;
};

export const chunkFilePath = (docCode: string) => join(CHUNKS_DIR, `${docCode}.jsonl`);

/** The chunks of one manual, or null when it hasn't been chunked yet */
export function readChunkFile(docCode: string): Chunk[] | null {
  const path = chunkFilePath(docCode);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The text that gets embedded: the manual and section path, then the content */
export function embeddingText(chunk: Chunk): string {
  const header = [chunk.manualTitle, chunk.sectionTitle].filter(Boolean).join(" › ");
  return `${header}\n\n${chunk.content}`;
}
