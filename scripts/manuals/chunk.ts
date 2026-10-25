/**
 * Chunker: turns each manual PDF into page-based chunks, following
 * scripts/manuals/CHUNKING.md.
 *
 * For every page: sort its lines into header, footer, side tab, side notes
 * and body; skip pages that aren't content (blank, contents, index); clean
 * and reorder the text; and make one chunk per page, split at its headings
 * only when the page is too long. The section path from the page header
 * becomes the chunk's section title.
 *
 * Manuals come from the `manuals` table; each one is written to
 * data/chunks/<doc_code>.jsonl (see chunk-file.ts). Nothing is embedded or
 * written to the database here — that's the upload step (upload.ts).
 *
 * Usage:
 *   npm run manuals:chunk                               # every manual
 *   npm run manuals:chunk -- BTYA2626OMEN B36T2424OMEN  # only these
 *   npm run manuals:chunk -- BTYA2626OMEN --show 384,634  # also print those pages' chunks
 */

import { mkdirSync, writeFileSync } from "fs";
import { db } from "../../src/prisma/db.ts";
import { CHUNKS_DIR, chunkFilePath, embeddingText, manualPdfPath, type Chunk } from "./chunk-file.ts";
import { readPages, type Line, type Page } from "./extract.ts";

const MAX_TOKENS = 700; // pages longer than this are split at their headings
const TARGET_TOKENS = 500; // size to aim for when splitting
const MIN_CHARS = 50; // pages with less text than this are blank or a picture

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

// ---------------------------------------------------------------------------
// Layout families
// ---------------------------------------------------------------------------

/**
 * honda: the classic Honda/Acura layout (landscape, side notes on the right)
 * adx:   the 2025+ ADX manuals (portrait, single column, IBM Plex fonts)
 * gm:    the 2024 ZDX manual, built by GM (three newspaper-style columns)
 */
type Family = "honda" | "adx" | "gm";

type Layout = {
  /** Lines ending above this fraction of the page height are the header */
  headerBottom: number;
  /** Optional stricter test for header lines, for layouts whose body text starts near the top */
  isHeader?: (line: Line, page: Page) => boolean;
  /** Lines starting below this fraction of the page height are the footer */
  footerTop: number;
  /** Lines starting right of this fraction of the page width are side notes */
  notesLeft: number | null;
  /** Lines within this fraction of the page width from either edge are the chapter tab */
  tabMargin: number;
  /** Column boundaries as fractions of the page width (empty: one column) */
  columns: number[];
  /** Whether a body line is a heading where a long page may be split */
  isHeading: (line: Line) => boolean;
};

const LAYOUTS: Record<Family, Layout> = {
  honda: {
    headerBottom: 0.08,
    // A tall chapter title ("Specifications", 14pt) can end just below the header band, so a line starting at the very top counts too
    isHeader: (l, page) => l.y0 < 0.04 * page.height || l.y1 < 0.08 * page.height,
    footerTop: 0.935,
    notesLeft: 0.6,
    tabMargin: 0.045,
    columns: [],
    isHeading: (l) => l.text.startsWith("■") || (l.bold && l.size >= 11.5),
  },
  adx: {
    headerBottom: 0.105,
    // The running head ("Before Driving") sits at the very top; the big section header uses a 19pt font
    isHeader: (l, page) => l.y0 < 0.05 * page.height || (l.size >= 15 && l.y1 < 0.105 * page.height),
    footerTop: 0.945,
    notesLeft: null,
    tabMargin: 0.03,
    columns: [],
    isHeading: (l) => l.bold && l.size >= 12,
  },
  gm: {
    headerBottom: 0.088,
    footerTop: 0.97,
    notesLeft: null,
    tabMargin: 0.02,
    columns: [0.33, 0.63],
    isHeading: (l) => l.bold && l.size >= 11.5,
  },
};

function detectFamily(pages: Page[]): Family {
  const fonts = pages.slice(0, 40).flatMap((p) => p.lines.map((l) => l.font));
  if (fonts.some((f) => f.startsWith("GMGlobal"))) return "gm";
  if (fonts.some((f) => f.startsWith("IBMPlex"))) return "adx";
  return "honda";
}

/**
 * Honda pages with tables side by side, like the Specifications pages
 * ("■Automatic Transmission Fluid", "■Engine Oil" and "■Tire" in three
 * columns): reading them row by row across the page would mix the tables'
 * cells, and the right-hand table would be taken for side notes. When two
 * "■" headings share a line, the page is read column by column instead,
 * each column starting at one of the headings, with no side notes.
 */
function withTableColumns(page: Page, layout: Layout): Layout {
  const headings = page.lines.filter(
    (l) =>
      l.text.startsWith("■") && l.y0 > layout.headerBottom * page.height && l.y0 < layout.footerTop * page.height,
  );
  const sideBySide = headings.some((a) => headings.some((b) => Math.abs(a.y0 - b.y0) < 3 && b.x0 - a.x0 > 100));
  if (!sideBySide) return layout;

  const starts: number[] = [];
  for (const x of headings.map((l) => l.x0).sort((a, b) => a - b)) {
    if (starts.length === 0 || x - starts[starts.length - 1] > 100) starts.push(x);
  }
  return { ...layout, notesLeft: null, columns: starts.slice(1).map((x) => (x - 5) / page.width) };
}

// ---------------------------------------------------------------------------
// One page
// ---------------------------------------------------------------------------

type Zones = { header: Line[]; body: Line[]; notes: Line[] };

/** Sort a page's lines into header, body and side notes; drop the footer and the chapter tab */
function splitZones(page: Page, layout: Layout): Zones {
  const zones: Zones = { header: [], body: [], notes: [] };
  for (const line of page.lines) {
    const inTab =
      line.vertical || line.x1 < layout.tabMargin * page.width || line.x0 > (1 - layout.tabMargin) * page.width;
    const inHeader = layout.isHeader?.(line, page) ?? line.y1 < layout.headerBottom * page.height;
    if (inHeader) zones.header.push(line);
    else if (line.y0 > layout.footerTop * page.height || inTab)
      continue; // page number, "Continued", chapter tab
    else if (layout.notesLeft !== null && line.x0 >= layout.notesLeft * page.width) zones.notes.push(line);
    else zones.body.push(line);
  }
  return zones;
}

/** Why a page should be skipped, or null to keep it */
function skipReason(zones: Zones): string | null {
  const lines = [...zones.body, ...zones.notes];
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  if (chars < MIN_CHARS) return "blank";

  const share = (re: RegExp) => lines.filter((l) => re.test(l.text)).length / lines.length;
  if (share(/(\.{4,}|…{2,})\s*\d[\d,\s]*$/) >= 0.3) return "index"; // "Brake Fluid ........ 342, 618"
  if (share(/P\.\s*\d+\s*$/) >= 0.3) return "contents"; // "Child Safety P. 71"
  if (zones.header.some((l) => /^(contents|index)$/i.test(l.text))) return "contents";
  return null;
}

/**
 * Group lines into visual rows, in reading order (column by column, top to
 * bottom). Lines are on the same row when they're at the same height with
 * the same font size (and at most `sameLineGap` apart), or when they overlap
 * vertically and sit side by side, like a table's label and its description.
 */
function readingOrder(lines: Line[], page: Page, layout: Layout, sameLineGap = Infinity): Line[][] {
  const column = (l: Line) => layout.columns.filter((c) => l.x0 >= c * page.width).length;
  const sorted = [...lines].sort((a, b) => column(a) - column(b) || a.y0 - b.y0 || a.x0 - b.x0);

  const rows: Line[][] = [];
  for (const line of sorted) {
    const row = rows[rows.length - 1];
    const sameRow =
      row &&
      column(row[0]) === column(line) &&
      row.some((other) => {
        const overlap = Math.min(other.y1, line.y1) - Math.max(other.y0, line.y0);
        const gap = Math.max(line.x0 - other.x1, other.x0 - line.x1);
        const sameLine =
          Math.abs(other.y0 - line.y0) < 2.5 && Math.abs(other.size - line.size) < 0.75 && gap < sameLineGap;
        const sideBySide =
          Math.abs(other.size - line.size) >= 0.75 &&
          Math.max(other.size, line.size) < 11 && // table text, never a large heading next to body text
          overlap > 0.5 * Math.min(other.y1 - other.y0, line.y1 - line.y0) &&
          gap < 60;
        return sameLine || sideBySide;
      });
    if (sameRow) row.push(line);
    else rows.push([line]);
  }
  for (const row of rows) row.sort((a, b) => a.x0 - b.x0);
  return rows;
}

const rowText = (row: Line[]) => row.map((l) => l.text).join(" ");
const STARTS_ITEM = /^(\d{1,2}\.\s|\[\d+\]|[•●›→■⚠✓*]|Note:|See\b|\([a-z]\)\s)/;

/** A paragraph and the height on the page where it starts */
type Paragraph = { text: string; y: number };

/**
 * Join rows into paragraphs: a line broken mid-sentence is joined to the
 * paragraph it continues (the closest recent one in the same column, right
 * above it), while steps and bullets stay separate.
 */
function toParagraphs(rows: Line[][]): Paragraph[] {
  const paragraphs: (Paragraph & { lastRow: Line[] })[] = [];
  for (const row of rows) {
    const text = rowText(row);
    const continues = (p: (typeof paragraphs)[number]) =>
      !/[.:!?]$/.test(p.text) &&
      p.lastRow.every((l) => l.bold) === row.every((l) => l.bold) && // a bold subheading isn't joined to its text
      Math.abs(p.lastRow[0].size - row[0].size) < 0.75 &&
      row[0].y0 - p.lastRow[0].y1 < 0.6 * row[0].size &&
      Math.abs(row[0].x0 - p.lastRow[0].x0) < 15;
    const target = STARTS_ITEM.test(text) ? undefined : paragraphs.slice(-3).reverse().find(continues);
    if (target) {
      // "Bluetooth-" + "compatible" and "audio/" + "information" join without a space
      const noSpace = (/-$/.test(target.text) && /^[a-z]/.test(text)) || /\/$/.test(target.text);
      target.text += noSpace ? text : ` ${text}`;
      target.lastRow = row;
    } else paragraphs.push({ text, y: row[0].y0, lastRow: row });
  }
  return paragraphs.map((p) => ({ text: cleanText(p.text), y: p.y })).filter((p) => p.text && !/^\d$/.test(p.text)); // a lone digit is a leftover icon or callout number
}

function cleanText(text: string): string {
  return text
    .replace(/\.{4,}/g, " … ") // dot leaders in spec tables
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^›\s*/, "→ ") // the arrow bullet inside instructions
    .trim();
}

/** The section path from the page header, e.g. "Maintenance › Changing the Engine Oil" */
function headerTitle(family: Family, header: Line[]): { title: string | null; chapterOnly: boolean } {
  const lines = [...header]
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    // GM pages print the page number on the header's line ("Driving and Operating 207") or on its own ("208")
    .map((l) => (family === "gm" ? { ...l, text: l.text.replace(/^\d+\s+|\s+\d+$/g, "") } : l))
    .filter((l) => !/^\d+$/.test(l.text)) // the page number
    .filter((l, i, all) => all.findIndex((o) => o.text === l.text) === i); // a running head printed twice
  const path = (text: string, sep: string) =>
    text
      .split(sep)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" › ");

  if (family === "honda") {
    const crumb = lines.find((l) => l.text.includes("›"));
    if (crumb) return { title: path(crumb.text, "›"), chapterOnly: false };
    const big = lines
      .filter((l) => l.size >= 12)
      .map((l) => l.text)
      .join(" ");
    return { title: big || null, chapterOnly: true }; // navigation manuals: the chapter name
  }
  if (family === "adx") {
    const text = lines.map((l) => l.text).join(" ");
    if (text.includes(">")) return { title: path(text.replace(/^\d+\s+/, ""), ">"), chapterOnly: false }; // "3 Controls > 9" Color Touchscreen"
    return { title: text || null, chapterOnly: true }; // running head with the chapter name only
  }
  return { title: lines.map((l) => l.text).join(" ") || null, chapterOnly: true }; // gm: "Lighting"
}

type Segment = { heading: string | null; paragraphs: Paragraph[]; y: number };

/** Split the body at its headings */
function segments(rows: Line[][], layout: Layout): Segment[] {
  const result: Segment[] = [];
  let rowsSoFar: Line[][] = [];
  let heading: string | null = null;
  let headingRow: Line[] | null = null;
  let y = rows[0]?.[0].y0 ?? 0;
  const flush = () => {
    if (rowsSoFar.length > 0 || heading) result.push({ heading, paragraphs: toParagraphs(rowsSoFar), y });
  };
  for (const row of rows) {
    if (row.some(layout.isHeading)) {
      const text = cleanText(rowText(row).replace(/^■\s*/, ""));
      // A heading wrapped onto two lines: same size, right below, nothing in between.
      // A heading followed by a smaller subheading is two headings.
      const wrapped =
        headingRow !== null &&
        rowsSoFar.length === 0 &&
        Math.abs(headingRow[0].size - row[0].size) < 0.75 &&
        row[0].y0 - headingRow[0].y1 < 0.6 * row[0].size;
      headingRow = row;
      if (wrapped) {
        heading += ` ${text}`;
        continue;
      }
      flush();
      heading = text;
      rowsSoFar = [];
      y = row[0].y0;
    } else rowsSoFar.push(row);
  }
  flush();
  return result;
}

/**
 * Figure labels (honda layout): small text next to an illustration, like
 * "3.0 L engine models" above "5.5 US qt (5.2 L)". Reading them in line order
 * would drop them into the middle of sentences, so they're kept out of the
 * paragraphs and inserted between them by their height on the page — which
 * puts a label right before the value it labels.
 */
function insertLabels(segs: Segment[], labels: Paragraph[]): Segment[] {
  for (const label of labels) {
    const seg =
      segs[
        Math.max(
          segs.findLastIndex((s) => s.y <= label.y),
          0,
        )
      ];
    if (!seg) continue;
    const at = seg.paragraphs.findIndex((p) => p.y > label.y);
    seg.paragraphs.splice(at < 0 ? seg.paragraphs.length : at, 0, label);
  }
  return segs;
}

/** The font size used by most of the body text */
function bodySize(lines: Line[]): number {
  const chars = new Map<number, number>();
  for (const l of lines) chars.set(l.size, (chars.get(l.size) ?? 0) + l.text.length);
  return [...chars].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

type Note = { title: string | null; text: string; y: number };

/** Side notes (honda layout): each starts with a title line marked by the note icon */
function sideNotes(lines: Line[], page: Page, layout: Layout): Note[] {
  const notes: Note[] = [];
  let rows: Line[][] = [];
  let title: string | null = null;
  let y = 0;
  const flush = () => {
    const text = toParagraphs(rows)
      .map((p) => p.text)
      .join("\n");
    if (text || title) notes.push({ title, text, y });
  };
  for (const row of readingOrder(lines, page, layout)) {
    if (row[0].noteTitle) {
      flush();
      title = cleanText(rowText(row));
      rows = [];
      y = row[0].y0;
    } else rows.push(row);
  }
  flush();
  return notes;
}

const segmentText = (s: Segment) => [s.heading, ...s.paragraphs.map((p) => p.text)].filter(Boolean).join("\n");
const notesText = (notes: Note[]) =>
  notes.length === 0
    ? ""
    : "\n\nNotes:\n" + notes.map((n) => [n.title, n.text].filter(Boolean).join("\n")).join("\n\n");

/** Split a too-long text at paragraph boundaries into pieces of about TARGET_TOKENS */
function splitParagraphs(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const paragraph of text.split("\n")) {
    if (current && estimateTokens(current + "\n" + paragraph) > TARGET_TOKENS) {
      pieces.push(current);
      current = paragraph;
    } else current = current ? `${current}\n${paragraph}` : paragraph;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * The section title of a chunk made of `group`, given the segments that come
 * before it on the page; `whole` is true when the chunk is the whole page.
 */
type TitleFor = (group: Segment[], before: Segment[], whole: boolean) => string | null;

/**
 * Build the chunks of one page: one chunk, or several when it's longer than
 * MAX_TOKENS. With `onePerTable` (pages of side-by-side tables, like the
 * Specifications) every table becomes its own chunk, whatever the page's
 * length: a page mixing fluids, tires and bulbs would match none of them
 * well, while a "Tire" chunk matches tire questions.
 */
function pageChunks(
  segs: Segment[],
  notes: Note[],
  titleFor: TitleFor,
  onePerTable = false,
): { sectionTitle: string | null; content: string }[] {
  const whole = segs.map(segmentText).join("\n\n") + notesText(notes);
  if (!onePerTable && estimateTokens(whole) <= MAX_TOKENS) {
    return [{ sectionTitle: titleFor(segs, [], true), content: whole.trim() }];
  }

  // Pack consecutive segments into groups of about TARGET_TOKENS, or one per table
  const groups: Segment[][] = [];
  for (const seg of segs) {
    const group = groups[groups.length - 1];
    const size = group ? estimateTokens(group.map(segmentText).join("\n\n") + segmentText(seg)) : Infinity;
    // A table page's text before its first table (e.g. "3.5 L engine models") goes with that table
    const joins = onePerTable ? group !== undefined && group.every((s) => !s.heading) : size <= TARGET_TOKENS;
    if (group && joins) group.push(seg);
    else groups.push([seg]);
  }

  // Each side note goes with the group it sits next to on the page
  const groupNotes = groups.map(() => [] as Note[]);
  for (const note of notes) {
    const i = groups.findLastIndex((g) => g[0].y <= note.y);
    groupNotes[Math.max(i, 0)].push(note);
  }

  return groups.flatMap((group, i) => {
    const sectionTitle = titleFor(group, groups.slice(0, i).flat(), false);
    const text = group.map(segmentText).join("\n\n") + notesText(groupNotes[i]);
    return splitParagraphs(text.trim()).map((content) => ({ sectionTitle, content }));
  });
}

// ---------------------------------------------------------------------------
// One manual
// ---------------------------------------------------------------------------

type ManualStats = {
  pages: number;
  skipped: Record<string, number>;
  chunks: number;
  maxTokens: number;
  family: Family;
};

function chunkManual(docCode: string, manualTitle: string, pdfPath: string): { chunks: Chunk[]; stats: ManualStats } {
  const pages = [...readPages(pdfPath)];
  const family = detectFamily(pages);
  const familyLayout = LAYOUTS[family];
  const chunks: Chunk[] = [];
  const skipped: Record<string, number> = {};

  let carriedTitle: string | null = null; // section path of the previous page, for pages without one
  let carriedHeading: string | null = null; // last heading seen, for layouts whose header names only the chapter
  let carriedChapter: string | null = null; // the chapter carriedHeading belongs to
  let qualifier: string | null = null; // e.g. "3.0 L engine models", for the pages of a section it labels
  let qualifierSection: string | null = null; // the header those pages share

  for (const page of pages) {
    const layout = family === "honda" ? withTableColumns(page, familyLayout) : familyLayout;
    const zones = splitZones(page, layout);
    const reason = skipReason(zones);
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }

    // Honda pages: small non-bold body text is a figure label, placed separately
    const size = bodySize(zones.body);
    const isLabel = (l: Line) => family === "honda" && !l.bold && l.size < size - 0.75;
    const rows = readingOrder(
      zones.body.filter((l) => !isLabel(l)),
      page,
      layout,
    );
    const labels = toParagraphs(readingOrder(zones.body.filter(isLabel), page, layout, 20));
    const segs = insertLabels(segments(rows, layout), labels);
    const notes = sideNotes(zones.notes, page, layout);

    // Section title. Honda pages: the section path from the header, or the
    // chapter plus the current heading (a split part adds its subheading).
    // ADX and GM pages, whose header names only the chapter and which often
    // hold several topics: the chapter plus every topic in the chunk, starting
    // with the topic continued from earlier when the chunk doesn't open with a
    // heading. Front-matter pages before the first header use their own first heading.
    const { title: fromHeader, chapterOnly } = headerTitle(family, zones.header);
    const firstHeading = segs.find((s) => s.heading)?.heading ?? null;
    // A heading continues onto the next pages of the same chapter only
    const inherited: string | null = fromHeader !== null && fromHeader === carriedChapter ? carriedHeading : null;
    const chapterHeading = segs[0]?.heading ?? inherited ?? firstHeading;
    const baseTitle: string | null =
      fromHeader && chapterOnly
        ? chapterHeading && chapterHeading !== fromHeader
          ? `${fromHeader} › ${chapterHeading}`
          : fromHeader
        : (fromHeader ?? carriedTitle ?? firstHeading);

    // Specifications come in one version per engine, labeled only on their
    // first page ("3.5 L engine models", then "3.0 L engine models"). On those
    // table pages the label goes in the title of every page of the version, so
    // a page like the 3.0 L engine's fluid table says which engine it's for.
    // Elsewhere "… engine models" is just a figure label, not a section label.
    const tablePage = layout !== familyLayout;
    const label = tablePage
      ? zones.body.find((l) => /\bengine models$/i.test(l.text) && l.y0 < 0.25 * page.height && l.x0 < 0.2 * page.width)
      : undefined;
    if (label) {
      qualifier = cleanText(label.text);
      qualifierSection = fromHeader;
    } else if (
      !tablePage ||
      fromHeader !== qualifierSection ||
      // a page that names another engine itself ("*2: 2.0 L engine models") covers more than one
      zones.body.some((l) => /\bengine models\b/i.test(l.text) && !l.text.includes(qualifier ?? ""))
    )
      qualifier = null;
    const pageTitle: string | null =
      qualifier && baseTitle && !baseTitle.includes(qualifier) ? `${baseTitle} › ${qualifier}` : baseTitle;

    const titleFor: TitleFor = (group, before, whole) => {
      if (fromHeader && chapterOnly && family !== "honda") {
        const continued = [...before].reverse().find((s) => s.heading)?.heading ?? inherited;
        const headings = [group[0]?.heading ? null : continued, ...group.map((s) => s.heading)];
        const topics = [...new Set(headings.filter((h): h is string => !!h && h !== fromHeader))].slice(0, 4);
        return topics.length > 0 ? `${fromHeader} › ${topics.join(", ")}` : fromHeader;
      }
      const heading = whole ? null : group[0]?.heading;
      return heading && !pageTitle?.endsWith(heading) ? [pageTitle, heading].filter(Boolean).join(" › ") : pageTitle;
    };

    carriedTitle = titleFor(segs, [], true); // the next page continues this page's full title
    carriedHeading = [...segs].reverse().find((s) => s.heading)?.heading ?? inherited;
    carriedChapter = fromHeader;

    // One chunk per table on pages of three or more table columns (the Specifications). Two
    // columns are usually one thing in two parts, like a fuse box and its table of fuses.
    const onePerTable = tablePage && layout.columns.length >= 2;
    for (const { sectionTitle, content } of pageChunks(segs, notes, titleFor, onePerTable)) {
      if (content.length < MIN_CHARS) continue;
      chunks.push({ docCode, manualTitle, page: page.number, sectionTitle, content, tokens: estimateTokens(content) });
    }
  }

  const stats = {
    pages: pages.length,
    skipped,
    chunks: chunks.length,
    maxTokens: Math.max(0, ...chunks.map((c) => c.tokens)),
    family,
  };
  return { chunks, stats };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const showAt = args.indexOf("--show");
  const showPages = showAt >= 0 ? (args[showAt + 1] ?? "").split(",").map(Number) : [];
  const codes = args.filter((a, i) => !a.startsWith("--") && (showAt < 0 || i !== showAt + 1));

  const all = [...(await db.orm.public.Manual.all())].sort(
    (a, b) => a.year - b.year || a.docCode.localeCompare(b.docCode),
  );
  const manuals = codes.length > 0 ? all.filter((m) => codes.includes(m.docCode)) : all;
  const unknown = codes.filter((c) => !all.some((m) => m.docCode === c));
  if (unknown.length > 0) {
    console.error(`Unknown doc_code(s): ${unknown.join(", ")} — run "npm run db:seed" first?`);
    process.exit(1);
  }

  mkdirSync(CHUNKS_DIR, { recursive: true });
  let total = 0;
  for (const manual of manuals) {
    const started = Date.now();
    const pdfPath = manualPdfPath(manual.year, manual.docCode);
    const { chunks, stats } = chunkManual(manual.docCode, manual.title, pdfPath);
    writeFileSync(chunkFilePath(manual.docCode), chunks.map((c) => JSON.stringify(c)).join("\n") + "\n");
    total += chunks.length;

    const skipped =
      Object.entries(stats.skipped)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "none";
    console.log(
      `${manual.docCode.padEnd(13)} ${stats.family.padEnd(5)} ${String(stats.pages).padStart(4)} pages → ` +
        `${String(stats.chunks).padStart(4)} chunks (max ${stats.maxTokens} tokens), skipped: ${skipped} ` +
        `[${((Date.now() - started) / 1000).toFixed(1)}s]`,
    );

    for (const chunk of chunks.filter((c) => showPages.includes(c.page))) {
      console.log(`\n----- page ${chunk.page} · ${chunk.tokens} tokens -----\n${embeddingText(chunk)}\n`);
    }
  }
  console.log(`\nWrote ${total} chunks for ${manuals.length} manuals to ${CHUNKS_DIR}/`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
