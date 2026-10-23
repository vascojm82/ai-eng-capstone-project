/**
 * PDF reader: turns each page of a manual into text lines with their
 * position and font, using MuPDF.js.
 *
 * Plain text extraction loses the layout (it interleaves the main column with
 * the side notes), so the chunker works from these positioned lines instead.
 * Icons drawn with Honda's symbol fonts (arrows, note markers, the hazard
 * triangle...) are converted to readable characters here, by font, so normal
 * words that happen to contain the same letters are left alone.
 */

import * as mupdf from "mupdf";
import { readFileSync } from "fs";

export type Line = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Font used by most characters of the line, without the subset prefix */
  font: string;
  /** Font size used by most characters of the line */
  size: number;
  /** Most characters of the line are in a bold font */
  bold: boolean;
  /** The line starts with a side-note marker (the "1" icon in HONDACommon) */
  noteTitle: boolean;
  /** Vertical text, e.g. the chapter tab on the page edge */
  vertical: boolean;
};

export type Page = {
  /** 1-based PDF page number */
  number: number;
  width: number;
  height: number;
  lines: Line[];
};

/** How a character drawn in an icon font should read as text ("" drops it) */
function mapIcon(font: string, c: string): string | null {
  if (font.startsWith("HONDACommon")) return c === "u" ? "›" : c === "2" ? "See" : c === " " ? " " : "";
  if (font.startsWith("HONDAHazard")) return c === "3" ? "⚠" : "";
  if (font.startsWith("HondaNa")) return ""; // Home button icon; the text "(Home)" follows it
  if (font.startsWith("Circles")) return /[a-zA-Z]/.test(c) ? `(${c})` : "";
  if (/^(omsym|Wingdings|HGPSoei)/i.test(font)) return ""; // private symbol fonts (button icons)
  // ADX manuals: "≫" marks a note; "･" is the dot leader of the contents and index pages
  if (font.startsWith("IBMPlexSansJP")) return c === "≫" ? "Note: " : c === "･" ? "." : c === "・" ? "" : c;
  return null; // a text font: keep the character as is
}

const isBold = (font: string) => /Bold|Black|Heavy/i.test(font);

/** Read every page of a PDF as positioned lines */
export function* readPages(path: string): Generator<Page> {
  // MuPDF objects live in WebAssembly memory, which isn't garbage collected:
  // each page and its text are freed after reading, the document at the end
  const doc = mupdf.Document.openDocument(readFileSync(path), "application/pdf");
  try {
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
      yield readPage(doc, i);
    }
  } finally {
    doc.destroy();
  }
}

function readPage(doc: mupdf.Document, i: number): Page {
  const page = doc.loadPage(i);
  const [px0, py0, px1, py1] = page.getBounds();
  const lines: Line[] = [];

  let text = "";
  let sizes = new Map<number, number>();
  let fonts = new Map<string, number>();
  let boldChars = 0;
  let chars = 0;
  let firstFont = "";
  let firstChar = "";
  let bbox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let vertical = false;

  const stext = page.toStructuredText("preserve-whitespace");
  stext.walk({
    beginLine(lineBbox, wmode, direction) {
      text = "";
      sizes = new Map();
      fonts = new Map();
      boldChars = 0;
      chars = 0;
      firstFont = "";
      firstChar = "";
      bbox = {
        x0: lineBbox[0] - px0,
        y0: lineBbox[1] - py0,
        x1: lineBbox[2] - px0,
        y1: lineBbox[3] - py0,
      };
      vertical = wmode === 1 || Math.abs(direction[1]) > Math.abs(direction[0]);
    },
    onChar(c, _origin, font, size) {
      const name = font.getName().replace(/^[A-Z]{6}\+/, ""); // drop the subset prefix, e.g. "GHPNCA+"
      if (!firstFont && c.trim()) {
        firstFont = name;
        firstChar = c;
      }
      const mapped = mapIcon(name, c);
      const out = (mapped ?? c).replace(/[\uE000-\uF8FF\uFFFD]/g, ""); // private-use and broken glyphs
      text += out;
      if (out.trim()) {
        const rounded = Math.round(size * 2) / 2;
        sizes.set(rounded, (sizes.get(rounded) ?? 0) + 1);
        fonts.set(name, (fonts.get(name) ?? 0) + 1);
        chars++;
        if (isBold(name)) boldChars++;
      }
    },
    endLine() {
      const clean = text.replace(/\s+/g, " ").trim();
      if (!clean) return;
      const mostUsed = <K>(counts: Map<K, number>) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      lines.push({
        text: clean,
        ...bbox,
        font: mostUsed(fonts) ?? "",
        size: mostUsed(sizes) ?? 0,
        bold: boldChars > chars / 2,
        noteTitle: firstFont.startsWith("HONDACommon") && firstChar === "1",
        vertical,
      });
    },
  });

  stext.destroy();
  page.destroy();
  return { number: i + 1, width: px1 - px0, height: py1 - py0, lines };
}
