# The uploader

How [`upload.ts`](upload.ts) (`npm run manuals:upload`) turns the chunk files into searchable rows in the database.

**In one sentence:** for each manual, read its chunks, turn each one into an embedding with OpenAI's `text-embedding-3-small`, and replace that manual's rows in the `chunks` table with the new ones, all at once.

---

## 1. Where it fits

Getting a manual ready for search takes three steps. The uploader is the last one:

```
manifest.csv ──► npm run db:seed ──► vehicles, manuals, vehicle_manuals   (which manual belongs to which car)

manual PDFs ──► npm run manuals:chunk ──► data/chunks/<doc_code>.jsonl     (the text, split into chunks)
                                                │
                                                ▼
                                  npm run manuals:upload ──► chunks table  (text + embedding, ready to search)
```

- **The chunker** ([`CHUNKING.md`](CHUNKING.md)) does all the reading and cleaning of the PDFs. Its output is plain files on your machine, so you can look at the chunks before anything is sent anywhere.
- **The uploader** only sends those chunks to OpenAI and stores the results. It never reads the PDF text itself; it only opens each PDF to count its pages.

Keeping them separate means you can re-run the chunker as often as you like for free. Only the upload costs money (a little) and changes the database.

---

## 2. What it needs

| What | Where it comes from |
|---|---|
| The `manuals` table filled in | `npm run db:seed` |
| One chunk file per manual | `npm run manuals:chunk`, which writes `data/chunks/<doc_code>.jsonl` |
| The manual PDFs (only to count pages) | `data/acura_manuals/manuals_<year>/raw/<doc_code>.PDF` |
| `OPENAI_API_KEY` and `OPENAI_BASE_URL` | `.env`. The base URL points at the bootcamp's LiteLLM proxy. |
| `DATABASE_URL` | `.env`. The connection to the production database. |

---

## 3. What happens to each manual

### Step 1: Read the chunk file

The uploader reads `data/chunks/<doc_code>.jsonl`. Each line of that file is one chunk, for example:

```json
{"docCode":"BTYA2626OMEN","manualTitle":"2026 MDX Owner's Manual","page":384,"sectionTitle":"Bluetooth® HandsFreeLink® › HFL Menus","content":"HFL Menus\nThe power mode must be in ACCESSORY or ON…","tokens":184}
```

If a manual has no chunk file yet, it's skipped with a message telling you to run the chunker first.

### Step 2: Build the text to embed

Each chunk is embedded **with a short header in front**: the manual's title and the section path, then a blank line, then the chunk text:

```
2026 MDX Owner's Manual › Bluetooth® HandsFreeLink® › HFL Menus

HFL Menus
The power mode must be in ACCESSORY or ON to use the system.
…
```

The header tells the embedding model what the passage is about, even when the text itself never says it (a list of steps like "Select Phone. Select Menu." doesn't mention Bluetooth). This text is built by `embeddingText()` in [`chunk-file.ts`](chunk-file.ts), so the chunker and the uploader always agree on it.

The header is only used for the embedding. The database stores the clean chunk text and the section title separately.

### Step 3: Get the embeddings

An **embedding** is a list of 1,536 numbers that describes what a piece of text means. Texts about similar things get similar lists of numbers, which is what makes searching by meaning possible.

The uploader asks OpenAI for these through the shared client in [`lib/openai.ts`](../../lib/openai.ts):

- **Model:** `text-embedding-3-small`, with 1,536 dimensions, matching the `vector(1536)` column in the database.
- **Batches:** 100 chunks per request, so a manual takes a handful of requests instead of hundreds.
- **Several at once:** up to 4 requests are sent at the same time, which makes a big manual roughly 4 times faster. The results are put back in the original order.
- **Retries:** if a request fails (for example the proxy is busy or rate-limits us), it waits and tries again: after 1, 2, 4 and then 8 seconds, up to 5 attempts in total. Only after the fifth failure does the upload stop.
- **Checks:** every answer must contain exactly one embedding per chunk, each with exactly 1,536 numbers. Anything else counts as a failed request.

### Step 4: Count the manual's pages

The uploader opens the PDF just long enough to count its pages, which becomes `manuals.page_count`. If the PDF isn't on this machine, `page_count` is left empty.

### Step 5: Replace the manual's chunks in one transaction

A **transaction** groups several database changes so that they either all happen or none of them do. For each manual, the uploader runs one transaction that:

1. **deletes** all of that manual's existing rows in `chunks`;
2. **inserts** the new chunks, 100 rows at a time, each with its `manual_id`, `page`, `section_title`, `content` and `embedding`;
3. **updates** the manual's row in `manuals` with its `page_count` and `ingested_at` (the current time).

If anything goes wrong in the middle (the connection drops, a row is rejected), the whole transaction is cancelled and the manual keeps exactly the chunks it had before. So a manual is never left half-uploaded, and searches never see a mix of old and new chunks.

The embeddings are all fetched **before** the transaction starts. That keeps the transaction short (only database work, no waiting on OpenAI), and if OpenAI fails, the database is never touched.

---

## 4. Safe to re-run

Running the uploader again never creates duplicates, because each manual's old chunks are deleted in the same transaction that inserts the new ones. That makes these situations simple:

| Situation | What to do |
|---|---|
| You improved the chunker | `npm run manuals:chunk`, then `npm run manuals:upload -- --force` |
| You fixed one manual | `npm run manuals:chunk -- <doc_code>`, then `npm run manuals:upload -- <doc_code>` |
| The upload stopped halfway (laptop closed, network down) | `npm run manuals:upload` again. It continues with the manuals not uploaded yet. |
| A new manual was added | `npm run db:seed`, `npm run manuals:chunk -- <doc_code>`, then `npm run manuals:upload` |

The resuming works because of `manuals.ingested_at`: it's set only when a manual's transaction succeeds, and with no arguments the uploader only processes manuals where it's still empty.

---

## 5. Commands

```sh
npm run manuals:upload                          # manuals not uploaded yet (ingested_at is empty)
npm run manuals:upload -- BTYA2626OMEN          # only these doc codes, even if already uploaded
npm run manuals:upload -- --force               # every manual, again
npm run manuals:upload -- --dry-run             # show what would happen; no API calls, no database writes
```

`--dry-run` is the safe way to check everything is in place: it lists each manual with its number of chunks and tokens and the estimated total cost, without spending anything or changing the database.

### What the output looks like

```
BT6N2222NM     130 chunks, ~21317 tokens → uploaded (replaced 0 old) [2.5s]
BT6N2222OM     473 chunks, ~120808 tokens → uploaded (replaced 0 old) [5.0s]
…
BTYA2626OMEN   749 chunks, ~191199 tokens → uploaded (replaced 0 old) [25.1s]

Uploaded 16222 chunks for 37 manuals (~4110252 tokens, about $0.08)
```

- **replaced N old:** how many chunks that manual had before. It's 0 on the first upload, and equal to the old count on a re-upload.
- **The time:** mostly spent waiting for OpenAI. It varies with how busy the proxy is.
- **The cost:** an estimate from the chunks' token counts at $0.02 per million tokens. The real bill comes from the proxy.

---

## 6. Size, time and cost

Measured on the full upload of all 37 manuals:

| | Result |
|---|---|
| Manuals | 37 |
| Chunks | 16,651 |
| Tokens embedded | about 4.1 million |
| Cost | about $0.08 |
| Time | a few minutes in total (about 2–30 seconds per manual) |
| Failed requests | none (a few rate-limited requests, about 20 per full upload, succeed on their first retry) |

---

## 7. How to check the result

These queries can be run in pgAdmin, or any PostgreSQL client connected with the details in `DATABASE_URL`, to confirm an upload worked.

```sql
-- chunks stored for each manual, with its page count and upload time
SELECT m.doc_code, m.page_count, m.ingested_at, COUNT(c.chunk_id) AS chunks
FROM manuals m
LEFT JOIN chunks c ON m.manual_id = c.manual_id
GROUP BY m.doc_code, m.page_count, m.ingested_at
ORDER BY m.doc_code;
```

Every manual should have a `page_count`, an `ingested_at` and the same number of chunks as lines in its `data/chunks/<doc_code>.jsonl` file.

```sql
-- every embedding should have 1,536 numbers
SELECT vector_dims(c.embedding) AS dims, COUNT(*) AS chunks
FROM chunks c
GROUP BY vector_dims(c.embedding);
```

This should return a single row: `1536 | 16651`.

After the first full upload, both checks passed, and a test with five real questions found the right page in the top 5 results every time.

---

## 8. Things to keep in mind

- **It writes to production.** `DATABASE_URL` points at the production database, so an upload changes the data the live app searches. Use `--dry-run` first if unsure.
- **The embedding model is fixed.** All chunks must be embedded with the same model and size as the questions that search them. Changing the model or the 1,536 size means a database migration and re-uploading every manual with `--force`.
- **One manual at a time.** Manuals are processed one after the other, so if the upload fails on one manual, the manuals before it are already safely stored.
- **Where the data goes.** The chunk text and `OPENAI_API_KEY` are sent to `OPENAI_BASE_URL` (the bootcamp's LiteLLM proxy), which forwards the request to OpenAI. The embeddings and chunks are written to the database in `DATABASE_URL`. Nothing is sent anywhere else.
