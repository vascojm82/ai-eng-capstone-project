# Chunking strategy for the Acura manuals

How the owner's and navigation manual PDFs are turned into the searchable rows of the `chunks` table, and why this approach was chosen.

**In one sentence:** read each PDF page with its layout, throw away what isn't content, clean what's left, make **one chunk per page** (splitting only pages that are too long), and put the page's section path in front of the text before embedding it.

---

## 1. Goal

The assistant answers questions like *"How do I pair my phone with my 2026 MDX?"* by:

1. picking the right manual in SQL (`vehicles → vehicle_manuals → manuals`), then
2. searching **only that manual's chunks** for the passages closest to the question, and
3. answering from those passages, **citing the manual and the PDF page**.

So a good chunk must:

- **answer one thing:** one topic or procedure, not half of two;
- **map to a page:** so the citation "page 384" is exact;
- **stand on its own:** a reader (or the LLM) can tell what it's about without the pages around it;
- **be a good size for embeddings:** roughly 150–700 tokens.

---

## 2. What the PDFs look like

There are 37 PDFs (23 owner's manuals, 14 navigation manuals, model years 2022–2026), about 16,900 pages and 5 million tokens in total. All of them have a real text layer, so no OCR is needed.

Measured on the 2026 MDX owner's manual (776 pages) and the 2026 RDX navigation manual (93 pages):

| What | Owner's manual | Navigation manual | Why it matters |
|---|---|---|---|
| Tokens per page | median 274, 90% under 497, max 1,322 | median 185, 90% under 472 | A page is already the right size for a chunk |
| Section path at the top of the page | 648 of 776 pages | 45 of 93 pages | A ready-made title for every chunk |
| `■` subheadings | about 1 per page | a few | Natural places to split a long page |
| Side-column notes | ~300 | yes | A second column of text that plain extraction mixes into the main one |
| Pages ending in "Continued" | 258 | 12 | About a third of topics run onto the next page |
| Printer stamp on every page | 774 pages | none | Junk that must be removed |
| Contents and index pages | ~12 | ~3 | Lists of keywords that would match almost any question; must be skipped |

### A typical owner's manual page

Each page has the same layout:

```
┌───────────────────────────────────────────────────────────────┐
│  uuMaintenance Under the HooduChanging the Engine Oil...      │  ← section path (small, top)
│                                                                │
│  ┌─────────────┐  4. Remove the oil filter...    │ 1Changing  │
│  │  figure     │  5. Check that the filter...    │ the Engine │  ← side notes
│  │ 3.5 L engine│  ...                             │ Oil...     │    (smaller text,
│  │ 3.0 L engine│  u Engine oil change capacity:  │ You will   │     right column)
│  └─────────────┘     5.6 US qt (5.3 L)            │ need a ... │
│                      5.5 US qt (5.2 L)            │            │
│                   ↑ main column (steps)                        │
│                                                    633         │  ← printed page number
│  26 ACURA MDX-31TYA6401.book 633 ページ 2025年11月4日…          │  ← printer stamp (junk)
└───────────────────────────────────────────────────────────────┘
```

The `u` characters in the section path are an arrow symbol in Honda's font: `uuMaintenance…uChanging the Engine Oil` means *Maintenance › Changing the Engine Oil*.

---

## 3. Extraction: read the layout, not just the text

**Tool:** [MuPDF.js](https://www.npmjs.com/package/mupdf) (`mupdf` on npm, a dev dependency). It's the TypeScript version of the MuPDF engine behind PyMuPDF.

Plain text extraction (what pypdf does) reads the page left to right, top to bottom, so it **interleaves the main column with the side notes** and **separates numbers from their labels**. MuPDF.js instead returns each **text block with its position and font**, for example on the oil-change page:

```
x=240 y=13  HONDACommon 7pt   uuMaintenance Under the Hood…uChanging the Engine Oil…   → section path
x=182 y=58  Frutiger 9pt      4. Remove the oil filter and dispose of the remaining oil… → main column
x=201 y=268 Frutiger 9pt      5.6 US qt (5.3 L)                                          → main column
x=364 y=60  HONDACommon 7pt   1Changing the Engine Oil and Oil Filter                    → side note title
x=371 y=73  Frutiger 7pt      You will need a special wrench…                            → side note text
x=132 y=252 Frutiger 7pt      Oil Filter 3.5 L engine models                             → label next to 5.6 qt
x=568 y=398 Frutiger 9pt      633                                                        → printed page number
```

With positions and font sizes, each block can be sorted into one of these roles:

| Role | How it's recognised | What happens to it |
|---|---|---|
| **Section path** | Top of the page, small Honda font, contains the `u` arrows | Becomes `section_title` |
| **Main column** | Larger body text (~9pt) in the middle of the page | Main chunk text, in reading order (top to bottom) |
| **Side notes** | Smaller text (~7pt) in the right column, title starts with `1` | Kept, after the main text, under a "Notes" heading |
| **Figure labels** | Small, non-bold text inside or next to an illustration | Kept, but placed between paragraphs by its height on the page, so a label lands right before the value it labels (e.g. "3.0 L engine models" before "5.5 US qt") instead of in the middle of a sentence |
| **Page number, side tab, printer stamp** | Fixed positions; the stamp contains `.book … ページ` | Dropped |

Positions are measured as **fractions of the page size**, not fixed coordinates, because page sizes differ between manuals.

### Three layout families

Not every manual uses the Honda layout above. The chunker recognizes the family from the fonts in the PDF and applies the matching rules:

| Family | Manuals | Page | How it's recognized | Differences |
|---|---|---|---|---|
| **Honda** | All owner's manuals except the two below, and all navigation manuals | 596×420, landscape | Frutiger and HONDACommon fonts | As described above. Navigation pages sometimes show a large chapter name at the top instead of the section path. |
| **ADX** | 2025 and 2026 ADX owner's manuals | 369×567, portrait | IBM Plex fonts | One column, no side notes. Header like `3 Controls > 9" Color Touchscreen`, or a small running head with just the chapter. Headings are 13pt bold. Notes start with `≫`. |
| **GM** | 2024 ZDX owner's manual (the ZDX is built by GM) | 538×360 | GMGlobalSans fonts | Three newspaper-style columns, read column by column. Header is the page number plus the chapter (e.g. `120 Lighting`). Headings are 12pt bold. |

### Icons

Honda draws small icons with special symbol fonts. Because the letters of ordinary words use normal text fonts, icons are converted by **font**, so a word like "Bluetooth" (which contains a `u`) is never touched:

| Font | Icon | Becomes |
|---|---|---|
| HONDACommon | `u` arrow | `›` (in paths) or `→` (as a bullet) |
| HONDACommon | `1` side-note marker | removed (marks the start of a note) |
| HONDACommon | `2` cross-reference | `See` (e.g. "See Editing Home Address P. 21") |
| HONDAHazard | `3` warning triangle | `⚠` |
| HondaNa001 | Home button | removed (the text "(Home)" follows it) |
| Circles | circled letters | `(a)`, `(b)`… |
| IBMPlexSansJP (ADX) | `≫` note marker | `Note:` |
| Wingdings, GM `omsym…` | button symbols | removed |

### Pages with tables side by side

Some Honda pages hold several tables next to each other. The Specifications pages are the main case:

```
■Automatic Transmission Fluid   ■Engine Oil                    ■Tire
Specified  Acura ATF-Type 2.0   Recommended ·0W-20             Size     275/40R21 107H
Capacity   Change 3.9 US qt     Capacity  Change 5.2 US qt     Regular  35 psi (240 kPa)
                                          Change including     Compact
■Rear Differential Fluid                  filter 5.5 US qt     Spare    60 psi (420 kPa)
…                               ■Engine Coolant …
```

Read line by line across the page, the rows of different tables get mixed: the transmission fluid's "3.9 US qt" ended up next to "Engine Oil", and the right-hand table was taken for side notes. An LLM reading that text quoted the wrong capacity.

So when **two or more `■` headings share a line**, the page is treated as a table page:

- **Column by column:** each column starts at one of those headings and is read top to bottom, one column after the other.
- **No side notes:** nothing on the page is taken for a side note, so the right-hand table stays a table.

The result reads cleanly, e.g. `Engine Oil / ·Acura Genuine Motor Oil 0W-20 … Change 5.2 US qt (4.9 L) Change including 5.5 US qt (5.2 L) filter`. About 150 pages across the 37 manuals are table pages, mostly Specifications and fuse pages.

---

## 4. Which pages are skipped

These pages are not turned into chunks:

- **Cover, back cover and blank pages:** fewer than ~50 characters of real text.
- **Table of contents:** the pages at the start that are mostly lines of the form *"Topic … page number"*.
- **Index:** the pages at the end, which are long alphabetical lists of keywords and page numbers.

The index is the most important one to skip. Because it contains every keyword in the manual, it would come back as a "close match" for almost every question while containing no actual instructions.

---

## 5. Cleaning

On every page that is kept:

1. **Remove** the printer stamp, the printed page number, the side tab (e.g. "Maintenance") and the word "Continued".
2. **Turn the arrow glyphs into readable separators:** `uuBluetooth® HandsFreeLink®uHFL Menus` → `Bluetooth® HandsFreeLink® › HFL Menus`. Inside instructions, the `u` bullet becomes `→`.
3. **Join lines broken mid-sentence** and collapse extra whitespace, keeping numbered steps (`1.`, `2.`…) and bullets on their own lines.
4. **Keep the content markers**, such as `*` (equipment not on every model), and warning words like `WARNING` and `NOTICE`.

---

## 6. Building the chunks

### One chunk per page

Each kept page becomes one chunk:

```
<main column text, top to bottom>

Notes:
<side notes, top to bottom>
```

**Why one page:** pages are already 150–500 tokens, Honda lays out roughly one topic per page, and the citation stays exact (`page` = this PDF page). The side notes explain the steps right next to them, so they stay in the same chunk.

### Long pages are split at their subheadings

If a page's text is over **~700 tokens** (about 3% of pages: 492 of 16,825), it's split at its subheadings into chunks of about 500 tokens: `■` subheadings in the Honda layout, bold headings in the ADX and GM layouts. Each side note goes with the part it sits next to on the page. A part that is still too long is split between paragraphs. Every part keeps the same `page` and `section_title`, and the subheading is added to the title (e.g. `HFL Menus › Phone menu screen`).

### Table pages: one chunk per table

On table pages with **three or more columns** (the Specifications pages and some voice-command lists), every table becomes its own chunk, whatever the page's length:

```
Specifications › 3.0 L engine models › Engine Oil       (42 tokens)
Specifications › 3.0 L engine models › Tire             (64 tokens)
Specifications › 3.0 L engine models › Engine Coolant   (51 tokens)
…
```

A whole Specifications page mixes fluids, oil, tires, wheels and bulbs, so its embedding is an average of all of them and matched no specific question well: a search for "tire pressure" never found the page that holds it. Each small table chunk matches its own questions. Text before the first table (such as "3.0 L engine models") goes with the first table.

Table pages with **two columns** stay one chunk, because their two parts usually belong together, like a fuse box and its table of fuses.

### Section titles

The title comes from the page header (section 3), with three refinements:

- **Engine versions:** the Specifications come in one version per engine, labeled only on their first page ("3.5 L engine models", then "3.0 L engine models"). On table pages that label is added to the title of every page of that version, e.g. `Specifications › 3.0 L engine models › Engine Oil`, so a page that never names its engine still says which one it's for. It isn't carried to a page that names another engine itself (one Integra table covers two engines with footnotes), and "… engine models" labels on ordinary pages are just figure labels, so they're ignored.
- **Chapter changes:** on pages whose header names only the chapter, the current heading carries over to the next pages of the same chapter, but never into the next chapter.
- **Chapter title pages:** a chapter's first page has a large title at the top (e.g. "Specifications", 14pt). Any line that starts at the very top of a Honda page counts as header, so these titles are recognized even when they reach slightly below the header band.

### No overlap

Chunks follow topic boundaries, so they don't need overlapping text the way fixed-size chunks do. A topic that continues on the next page shares the same section path, so the two pages are clearly connected, and both will match a question about that topic.

### What's stored for each chunk

| `chunks` column | Value |
|---|---|
| `manual_id` | The manual the PDF belongs to |
| `page` | The **PDF** page number, starting at 1, which is what `#page=N` links open. It's usually the printed page number + 1. |
| `section_title` | The cleaned section path, e.g. `Maintenance › Changing the Engine Oil and Oil Filter` |
| `content` | The cleaned chunk text (what the LLM reads) |
| `embedding` | The embedding of the text described below |

After a manual is processed, its `manuals.page_count` and `manuals.ingested_at` are set.

---

## 7. What gets embedded

The embedding is computed from the chunk text **with a short header in front**:

```
2026 MDX Owner's Manual › Bluetooth® HandsFreeLink® › HFL Menus

To use HFL, you must first pair your Bluetooth-compatible cell phone…
```

The header tells the embedding model what the passage is about even when the text itself never repeats the topic (a page of steps like "Select Menu. Select Pair." doesn't mention "Bluetooth"). Because the manual already provides this context, no extra LLM calls are needed to write it.

- **Model:** OpenAI's `text-embedding-3-small`, 1,536 dimensions. Locally the requests go through the bootcamp's LiteLLM proxy (`OPENAI_BASE_URL`), which forwards them to the same model.
- **Batching:** about 100 chunks per request.
- **Re-running:** a manual is re-processed by deleting its chunks and inserting the new ones in one transaction, so re-running never leaves duplicates or a half-processed manual.

---

## 8. Size and cost

Measured on the output of `npm run manuals:chunk`:

| | Result |
|---|---|
| Chunks | 16,651 for all 37 PDFs |
| Chunks per manual | 83–154 (navigation) to 356–769 (owner's) |
| Tokens per chunk | median 229, 90% under 430, maximum 700 |
| Tokens to embed | about 4.1 million |
| Embedding cost | about $0.08 with `text-embedding-3-small` |
| Run time | about 80 seconds for all 37 PDFs |

Searching one manual compares the question against at most ~750 chunks, so no special vector index is needed.

---

## 9. Why not fixed-size chunks?

The usual default is to cut the text every ~500 tokens with some overlap. For these manuals that works worse:

| | Fixed-size (500 tokens + overlap) | Page-based (this strategy) |
|---|---|---|
| Citations | A chunk often spans two pages | Always one exact page |
| Topics | Can cut a procedure in half or mix two topics | Follows Honda's own topic layout |
| Side notes | Mixed into the main steps | Kept together after the main steps |
| Context | Each chunk starts mid-text | Every chunk has its section path |
| Junk | Stamps, index pages and page numbers end up in chunks | Removed before chunking |

---

## 10. Known edge cases

- **Values for different engines or trims:** e.g. oil capacity *5.6 US qt* for the 3.5 L engine and *5.5 US qt* for the 3.0 L. Figure labels are placed by their height on the page, so each value follows its label. In the Specifications, the engine is in the section title (see "Section titles"), and tables that cover several engines say so with footnotes (`*1: 2.0 L engine models`), which are kept.
- **Table rows:** a row's label and its description use different font sizes but sit side by side, so they're kept on one line (e.g. "Keypad Enter a phone number to dial.").
- **Cells inside a table** can still come out in a slightly unusual order (e.g. `Regular Pressure / 35 (240 [2.4]) / psi (kPa [kgf/cm2])`), but each value stays inside its own table, next to its label.
- **Warning boxes side by side** on a few pages (e.g. "Automatic Brake Hold" in some manuals) count as table columns, so each warning becomes its own chunk titled `… › ⚠WARNING`. Each one is a complete warning, and its text names the feature.
- **Illustration callouts:** labels spread around a picture (e.g. "Bluetooth Indicator", "Battery Level") are kept as separate lines; their order follows the picture top to bottom and may not match how a person would read it.
- **Front-matter pages:** the welcome pages before the first section (PDF pages 2–5 of most owner's manuals) have no section path or heading, so their `section_title` is empty (83 chunks). Their embedding header still names the manual.
- **GM warning boxes** continue across pages with "Warning (Continued)"; that text is part of the content and is kept.
- **Repeated text:** some manuals print the same paragraph on two pages (e.g. a feature described for two trims), which gives identical chunks on different pages (44 cases). Both are kept, since both pages are valid citations.
- **ZDX button icons** (GM's symbol fonts) are removed, so a sentence like "pressing [lock icon] on the remote key" reads "pressing on the remote key".
- **Revised editions:** the 2022 MDX manuals have revision notes in `manuals.edition`; their content is processed the same way.
- **Pages with mostly a picture** (e.g. dashboard indicator lights) may have little text. They're kept if they have at least 50 characters of text.

---

## 11. How to check that it works

Before relying on it, test retrieval on real questions:

1. Write **~25 questions with known answers**, e.g. *"What is the oil capacity of the 2026 MDX 3.0 L?"* → PDF page 634.
2. For each question, embed it and search the right manual.
3. Count how often the correct page is in the **top 5** results (recall@5).

If a type of question keeps failing (e.g. exact spec values), adjust the extraction or splitting rules and re-run.

---

## 12. Running it

```sh
npm run manuals:chunk                                  # all manuals in the manuals table
npm run manuals:chunk -- BTYA2626OMEN B36T2424OMEN     # only these doc codes
npm run manuals:chunk -- BTYA2626OMEN --show 384,634   # also print those pages' chunks
```

- **Input:** the manuals listed in the `manuals` table (run `npm run db:seed` first), read from `data/acura_manuals/manuals_{year}/raw/{doc_code}.PDF`.
- **Output:** one file per manual, `data/chunks/{doc_code}.jsonl`, one chunk per line with `docCode`, `manualTitle`, `page`, `sectionTitle`, `content` and `tokens`. The folder is gitignored; re-run the command to rebuild it.
- **Code:** [`extract.ts`](extract.ts) reads the PDF pages as positioned lines and converts the icons; [`chunk.ts`](chunk.ts) does everything else (layout families, zones, skipping, cleaning, chunks).
- **Not done here:** embedding and writing to the `chunks` table. That's a separate upload step, which reads these files.
