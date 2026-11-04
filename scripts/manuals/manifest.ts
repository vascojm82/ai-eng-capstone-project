/**
 * The manifests written by fetch_manuals.py
 * (data/acura_manuals/manuals_<year>/manifest.csv): one row per trim and
 * manual. Shared by the seeder and the manual updater.
 */

import { createHash } from "crypto";
import { createReadStream, readFileSync } from "fs";

export type ManifestRow = {
  year: string;
  model: string;
  trim: string;
  model_id: string;
  title: string;
  file: string;
  url: string;
};

/** Minimal CSV parser: handles quoted fields, escaped quotes and commas inside quotes */
export function parseCsv(text: string): ManifestRow[] {
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

export const readManifest = (path: string) => parseCsv(readFileSync(path, "utf-8"));

/** Rows for PDF manuals; the interactive (HTML) manuals are skipped */
export const isPdfRow = (row: ManifestRow) => /\.pdf$/i.test(row.url);

/** File code from the manual URL: .../BTYA2626OMEN.PDF -> BTYA2626OMEN */
export function docCodeFromUrl(url: string): string {
  const file = new URL(url).pathname.split("/").pop()!;
  return file.replace(/\.[^.]+$/, "");
}

/** "2022 MDX Owner's Manual (Revised 2021-12-16)" -> { title: "2022 MDX Owner's Manual", edition: "Revised 2021-12-16" } */
export function splitEdition(title: string): { title: string; edition: string | null } {
  const match = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return match ? { title: match[1], edition: match[2] } : { title, edition: null };
}

export function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
