# Car Service Assistant

A question-answering assistant for Acura owners. Users log in, ask questions in plain English ("What tire pressure should I use on my 2026 MDX?"), and get short answers taken **only** from the official owner's and navigation manuals for their exact model year and model, with a citation to the PDF page.

It's a retrieval-augmented generation (RAG) app with one agent, a SQL database and a vector index:

- **SQL** decides *which manuals* belong to the user's car.
- **Vector search (pgvector)** finds *which passages* of those manuals answer the question.
- **An LLM agent** asks for missing details (model, year), calls those two tools, and writes the answer from the passages, never from outside knowledge.

> This is an unofficial project. Answers come from Acura's published manuals; it isn't affiliated with Acura or Honda.

**Production:** https://dctpsbjexnavhciqbet8z0rf.ewr.prisma.build (login required)

---

## Contents

1. [Features](#1-features)
2. [Architecture](#2-architecture)
3. [How a question is answered](#3-how-a-question-is-answered)
4. [The data pipeline](#4-the-data-pipeline)
5. [The database](#5-the-database)
6. [The agent](#6-the-agent)
7. [Login and usage limits](#7-login-and-usage-limits)
8. [The frontend](#8-the-frontend)
9. [Project structure](#9-project-structure)
10. [Setup](#10-setup)
11. [Running locally](#11-running-locally)
12. [Deploying on Prisma](#12-deploying-on-prisma)
13. [API reference](#13-api-reference)
14. [Configuration reference](#14-configuration-reference)
15. [npm scripts](#15-npm-scripts)
16. [Testing the main scenarios](#16-testing-the-main-scenarios)
17. [Troubleshooting](#17-troubleshooting)
18. [Known limitations](#18-known-limitations)
19. [Further documentation](#19-further-documentation)

---

## 1. Features

| Feature | What it does |
|---|---|
| **Vehicle-aware answers** | Detects the model year and model in the conversation ("my 2026 MDX") and searches only that car's manuals, so answers never mix vehicles. |
| **Clarifying questions** | Missing the model or year? The assistant asks ("What model year is your MDX?") instead of guessing. |
| **Citations** | Every fact cites the manual and PDF page; the UI shows each source as a link that opens the PDF at that page. |
| **Specifications** | For value questions (capacities, pressures, fluids), it also searches the Specifications tables, which are chunked one table at a time. |
| **Honest "not found"** | If the manual doesn't contain the answer (prices, dealer services…), it says so and suggests a dealer. |
| **Scope rules** | Off-topic questions get "Please ask a question about Acura cars."; repair and diagnosis questions are declined; engine oil, transmission fluid and brake pad changes start with a recommendation to book a dealer appointment. |
| **Conversation memory** | Follow-ups work ("And how much oil does the 3.0 L take?"); the car named earlier in the chat is remembered. |
| **Login and limits** | Two accounts (`user`, `admin`); 20 questions per user per hour and 300 per day for the whole app, to cap OpenAI costs. |
| **Coverage** | 37 manuals (23 owner's, 14 navigation) for 135 US trims, model years 2022–2026: ADX, ILX, Integra, MDX, NSX, RDX, TLX, ZDX. |

---

## 2. Architecture

One Node.js service serves both the React frontend and the API. It uses one PostgreSQL database (with the pgvector extension) for the vehicle catalog and the embeddings, and calls OpenAI for embeddings and chat.

```mermaid
flowchart LR
    Browser["Browser<br/>React + Material UI"]

    subgraph Service["Express server (one service on Prisma Compute)"]
        Static["Static files<br/>dist/public"]
        Auth["/api/login · /api/logout · /api/me<br/>session cookie"]
        Limits["Usage limits"]
        Chat["/api/chat"]
        Search["/api/search"]
        Agent["Agent<br/>agents/manual-assistant.ts"]
        Lib["Search library<br/>lib/search.ts"]
    end

    DB[("PostgreSQL + pgvector<br/>vehicles · manuals · vehicle_manuals · chunks")]
    OpenAI["OpenAI API<br/>gpt-6-luna · text-embedding-3-small"]

    Browser -->|"GET /"| Static
    Browser -->|"POST /api/login"| Auth
    Browser -->|"POST /api/chat"| Limits --> Chat --> Agent
    Browser -->|"POST /api/search"| Limits --> Search --> Lib
    Agent -->|"tools"| Lib
    Agent -->|"chat completions"| OpenAI
    Lib -->|"embed the question"| OpenAI
    Lib -->|"SQL + vector search"| DB
```

### Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Material UI 9, Vite 8, `react-markdown` |
| Backend | Node.js 22 (Bun on Prisma), Express 5, TypeScript |
| Database | PostgreSQL 15+ with pgvector, Prisma ORM 8 (contract + migrations) |
| AI | OpenAI `gpt-6-luna` (agent), `text-embedding-3-small` (1,536-dimension embeddings) |
| PDF processing | MuPDF.js (layout-aware text extraction) |
| Hosting | Prisma Compute (app) + Prisma Postgres (database), deployed from GitHub Actions |

---

## 3. How a question is answered

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as React app
    participant API as Express /api/chat
    participant AG as Agent
    participant LLM as OpenAI gpt-6-luna
    participant S as lib/search.ts
    participant DB as Postgres + pgvector
    participant EMB as OpenAI embeddings

    U->>FE: "What tire pressure should I use on my 2026 MDX?"
    FE->>API: POST /api/chat { messages: [...] } + session cookie
    API->>API: check session, count against limits
    API->>AG: runAgent(conversation)
    AG->>AG: find the vehicle in the conversation → 2026 MDX
    AG->>LLM: instructions + vehicle note + last 5 messages + tools
    LLM-->>AG: call search_manuals("tire pressure on a 2026 MDX")<br/>and search_manuals("specifications tire pressure on a 2026 MDX")
    AG->>S: searchManuals(query, k=5) ×2
    S->>S: detect "2026" + "MDX" → manuals via vehicle_manuals
    S->>EMB: embed the query
    EMB-->>S: 1,536 numbers
    S->>DB: nearest chunks by cosine distance, only in those manuals
    DB-->>S: passages + pages
    S-->>AG: passages
    AG->>LLM: the passages
    LLM-->>AG: "35 psi … (2026 MDX Owner's Manual, p. 752)"
    AG->>AG: keep only the cited pages as sources
    AG-->>API: { reply, sources, steps }
    API-->>FE: JSON
    FE-->>U: answer + source chips (open the PDF at the page)
```

The key idea is **filter first, then search**: the vector search never looks at other cars' manuals. Model years of the same model are nearly identical text, so an unfiltered search mixes them up; the SQL step guarantees the exact year and model.

---

## 4. The data pipeline

The manuals become searchable in four steps, all run on a developer machine. Only the results (rows in Postgres) are needed in production.

```mermaid
flowchart TD
    A["fetch_manuals.py<br/>(owner's site → PDFs + manifest.csv)"] --> B["data/acura_manuals/manuals_YEAR/<br/>manifest.csv · raw/*.PDF"]
    B --> C["npm run db:seed<br/>vehicles · manuals · vehicle_manuals"]
    B --> D["npm run manuals:chunk<br/>PDF → page-based chunks"]
    C --> D
    D --> E["data/chunks/DOC_CODE.jsonl"]
    E --> F["npm run manuals:upload<br/>embed + write to chunks"]
    F --> G[("Postgres: 16,651 chunks<br/>with embeddings")]
```

| Step | Command | Input → output | Details |
|---|---|---|---|
| 1. Download | `python3 fetch_manuals.py --year 2026 --out manuals_2026` (in `data/acura_manuals/`) | Honda/Acura owner site → `manifest.csv`, `raw/*.PDF` | The PDFs (≈5 GB with per-trim copies) are gitignored; the manifests are committed. |
| 2. Seed | `npm run db:seed` | manifests → `vehicles`, `manuals`, `vehicle_manuals` | One manual row per unique PDF; interactive (HTML) manuals are skipped. Safe to re-run. |
| 3. Chunk | `npm run manuals:chunk` | PDFs → `data/chunks/<doc_code>.jsonl` | ~80 s for all 37 PDFs. See [CHUNKING.md](scripts/manuals/CHUNKING.md). |
| 4. Upload | `npm run manuals:upload` | chunk files → `chunks` (text + embedding) | ~4.1M tokens, about $0.08. One transaction per manual. See [UPLOADING.md](scripts/manuals/UPLOADING.md). |

### Chunking in short

The manuals have a very regular layout, so the chunker follows it instead of cutting every N tokens:

- **One chunk per PDF page** (median 229 tokens), which keeps citations exact. Pages over ~700 tokens are split at their subheadings.
- **Layout-aware extraction** with MuPDF.js: the main column and the side notes are separated, figure labels are placed next to the values they label, and side-by-side tables (the Specifications) are read column by column, **one chunk per table** ("Specifications › 3.0 L engine models › Tire").
- **Section titles** come from each page's header path ("Maintenance › Changing the Engine Oil and Oil Filter") and are prepended to the text before embedding.
- **Three layout families** are recognized by their fonts: the classic Honda layout, the 2025+ ADX layout, and the GM-built 2024 ZDX.
- **Skipped:** covers, blank pages, contents and index pages.

---

## 5. The database

```mermaid
erDiagram
    vehicles ||--o{ vehicle_manuals : "is covered by"
    manuals  ||--o{ vehicle_manuals : "covers"
    manuals  ||--o{ chunks : "is split into"

    vehicles {
        serial vehicle_id PK
        text model "MDX"
        int year "2026"
        text trim
        text market "US"
    }
    vehicle_manuals {
        int vehicle_id PK, FK
        int manual_id PK, FK
    }
    manuals {
        serial manual_id PK
        text doc_code UK "BTYA2626OMEN"
        text title
        text manual_type "owner | navigation"
        int year
        text source_url
        int page_count
        timestamptz ingested_at
    }
    chunks {
        serial chunk_id PK
        int manual_id FK
        int page
        text section_title
        text content
        vector_1536 embedding
    }
```

- Many trims share one PDF, so **manuals** has one row per PDF and **vehicle_manuals** links trims to manuals (many-to-many).
- **chunks.embedding** is a `vector(1536)` column (pgvector). Searches filter by `manual_id` first, then order by cosine distance.
- The schema lives in [`src/prisma/contract.prisma`](src/prisma/contract.prisma); migrations are in [`migrations/`](migrations) and are applied automatically on deploy. The full column list is in [`scripts/db/schema.md`](scripts/db/schema.md).

---

## 6. The agent

[`agents/manual-assistant.ts`](agents/manual-assistant.ts) is a single tool-using agent around `gpt-6-luna` (OpenAI Chat Completions, `reasoning_effort: "none"`, `temperature: 0.2`).

```mermaid
flowchart TD
    Start(["POST /api/chat"]) --> Vehicle["Find the vehicle in the conversation (code)<br/>→ note for the model"]
    Vehicle --> Build["System prompt + scope rules + vehicle note<br/>+ last 5 messages"]
    Build --> Call["Call the model with the tools"]
    Call --> Q{"Tool calls?"}
    Q -- "yes" --> Run["Run find_manuals / search_manuals<br/>append the results"]
    Run --> Rounds{"Under 5 rounds?"}
    Rounds -- "yes" --> Call
    Rounds -- "no" --> Fallback["Fallback: ask to rephrase"]
    Q -- "no" --> Reject{"Contains a fixed<br/>reject reply?"}
    Reject -- "yes" --> Exact["Return exactly that reply"]
    Reject -- "no" --> Cite["Return the reply + the pages it cites"]
```

**Tools**

| Tool | Backed by | Purpose |
|---|---|---|
| `find_manuals(year?, model?)` | SQL (cached catalog) | Which models and years exist; which manuals cover a vehicle |
| `search_manuals(query, k)` | `lib/search.ts` | Vehicle detection → manuals → pgvector search inside them (k between 5 and 10) |

**What's enforced in code rather than left to the model**

- **The vehicle:** `knownVehicle()` scans the user's messages newest first. The model comes from the latest message naming one; the year from that message or one naming no model. A message about a different car ends the scan, so "2026 Integra…" then "my MDX?" makes the agent ask for the MDX's year.
- **The conversation window:** the model sees only the last 5 messages; the vehicle is still found in the whole conversation the client sends (up to 30).
- **Exact rejections:** if a reply contains one of the fixed reject sentences, only that sentence is returned.
- **Citations → sources:** only the pages the reply actually cites are returned as `sources`.
- **Loop limit:** at most 5 model↔tool rounds per message.

**Scope rules** are defined as few-shot examples in `fewShotExamples` and rendered into the system prompt:

| Kind of question | Reply |
|---|---|
| Not about Acura vehicles | "Please ask a question about Acura cars." |
| Diagnose or repair a problem (noise, warning light, broken part) | "We never advise on fixing the car yourself. Please set up an appointment with an Acura dealer." |
| Engine oil, transmission fluid or brake pad change | Starts with "We advise you to set up an appointment to get this done with an Acura dealer.", then the manual's steps if it has them |
| Anything else about an Acura | Searched and answered from the manual, with citations |

---

## 7. Login and usage limits

```mermaid
sequenceDiagram
    actor U as User
    participant FE as React app
    participant API as Express

    U->>FE: username + password
    FE->>API: POST /api/login
    API->>API: scrypt check against APP_USERS
    API-->>FE: Set-Cookie: session=… (HttpOnly, Secure, SameSite=Lax, 7 days)
    FE->>API: POST /api/chat (cookie sent automatically)
    API->>API: verify HMAC signature + expiry, count the question
    API-->>FE: 200 answer · 401 not logged in · 429 over the limit
```

- **Accounts:** `user` (role `user`) and `admin` (role `admin`, reserved for future admin features). Passwords are stored only as **scrypt hashes** in the `APP_USERS` setting. `npm run auth:users` generates strong random passwords, writes the hashes to `.env` and the passwords to `.credentials.local` (gitignored, readable only by you).
- **Sessions:** a stateless cookie containing the username, role and expiry, signed with `SESSION_SECRET` (HMAC-SHA256). Tampered or expired cookies are rejected.
- **Limits** ([`lib/limits.ts`](lib/limits.ts)), each answered with `429` and a `Retry-After` header:

| Limit | Value |
|---|---|
| Questions per user | 20 per rolling hour |
| Questions for the whole app | 300 per day (UTC) |
| Login attempts per IP | 10 per 15 minutes |

The counters live in the server's memory: they reset on restart and aren't shared between instances. As a last line of defense, also set a monthly budget on your OpenAI account.

---

## 8. The frontend

A single-page React app in [`web/`](web), built by Vite into `dist/public` and served by Express from the same origin (no CORS, the session cookie just works).

| Screen | Contents |
|---|---|
| **Login** | Username/password card, error messages, loading state |
| **Chat** | Black header (user, new conversation, log out), message bubbles, Markdown answers, source chips that open the PDF at the cited page, example questions on an empty chat, "Searching the manuals…" indicator, input with Enter to send and Shift+Enter for a new line |

- **State:** the conversation is kept in the browser's `localStorage` per user and sent in full with every `/api/chat` call; the server stores nothing.
- **Theme:** [`web/src/theme.ts`](web/src/theme.ts), colors taken from acura.com (black `#000000` header, red `#E82C2A` buttons, `#F3F3F3` background), square upper-case buttons, Nunito Sans font.
- **Responsive:** on phones the header collapses to icons.

---

## 9. Project structure

```
.
├── server.ts                  # Express app: /api routes + serves the built frontend
├── routes/
│   ├── auth.ts                # /api/login, /api/logout, /api/me
│   └── index.ts               # /api/chat, /api/search (login + limits)
├── agents/
│   └── manual-assistant.ts    # the agent: prompt, scope rules, tools, loop
├── lib/
│   ├── search.ts              # vehicle → manuals (SQL) → pgvector search
│   ├── vehicles.ts            # year/model detection in text
│   ├── auth.ts                # password hashing, signed session cookie, requireAuth
│   ├── limits.ts              # usage limits
│   ├── openai.ts              # OpenAI client, embeddings
│   ├── config.ts              # settings: Prisma (service.ts) vs local (.env)
│   └── env.ts                 # loads .env
├── web/                       # React frontend (Vite)
│   ├── src/                   # App, LoginPage, ChatPage, api.ts, theme.ts
│   ├── public/favicon.svg
│   └── vite.config.ts
├── scripts/
│   ├── db/seed.ts             # npm run db:seed
│   ├── db/schema.md           # schema diagram and column list
│   ├── manuals/               # chunk.ts, extract.ts, upload.ts + CHUNKING.md, UPLOADING.md
│   └── auth/create-users.ts   # npm run auth:users
├── src/prisma/                # contract.prisma (schema), generated contract, db.ts
├── migrations/                # Prisma migrations (applied on deploy)
├── data/acura_manuals/        # fetch_manuals.py, manifests (PDFs gitignored)
├── service.ts · module.ts     # Prisma Compute: the service, its database and settings
├── prisma.config.ts           # Prisma ORM + deploy configuration
└── .github/workflows/prisma-deploy.yml
```

---

## 10. Setup

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js | 22.18+ (or 24.11+) | Everything |
| npm | 10+ | Dependencies |
| Python 3 + `certifi` | 3.9+ | Only to download the manuals (`fetch_manuals.py`) |
| PostgreSQL with pgvector | 15+ | The database (Prisma Postgres provides one) |
| OpenAI API key | | Embeddings and the agent |
| Prisma CLI login | | Only for deploying (`npx prisma auth login`) |

### 1. Install

```sh
git clone git@github.com:vascojm82/ai-eng-capstone-project.git
cd ai-eng-capstone-project
npm install
```

> The Prisma packages are pinned to versions that must match each other (`prisma` 8.0.0-rc.25, `@prisma/orm-postgres` 8.0.0-rc.19, `@prisma/composer*` 0.33.0). Don't upgrade one alone.

### 2. Environment variables

```sh
cp .env.example .env
```

Fill in `.env`:

```sh
OPENAI_API_KEY=sk-...                         # your OpenAI key
OPENAI_BASE_URL=https://api.openai.com/v1     # optional; set it only to use a proxy
DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/postgres?sslmode=verify-full"
```

### 3. A database

**Option A: the project's Prisma Postgres database** (what production uses). Create a connection for local scripts; its URL is printed once, so put it straight into `.env` as `DATABASE_URL`:

```sh
npx prisma auth login
npx prisma postgres list --project capstone-project --branch main
npx prisma postgres connection create <database-id> --project capstone-project --branch main --name local-scripts
```

**Option B: your own PostgreSQL 15+ with pgvector.** Point `DATABASE_URL` at it and apply the migrations:

```sh
npx prisma db migrate
```

Check with `npx prisma migration status` (it should say "Up to date").

### 4. Login accounts

```sh
npm run auth:users
```

This writes `APP_USERS` and `SESSION_SECRET` to `.env` and the passwords to `.credentials.local`. Use `-- --force` to replace both passwords (logs everyone out).

### 5. Data (skip if the database already has it)

```sh
# 1. Download the PDFs (per year), from data/acura_manuals
cd data/acura_manuals
python3 fetch_manuals.py --year 2026 --out manuals_2026   # repeat for 2022–2025
cd ../..

# 2–4. Fill the database
npm run db:seed
npm run manuals:chunk
npm run manuals:upload -- --dry-run   # shows chunk and token counts, no cost
npm run manuals:upload
```

Re-running any step is safe: the seed and the upload replace rows instead of duplicating them, and `manuals:upload` without arguments continues with manuals not uploaded yet.

---

## 11. Running locally

### Development mode (instant reload)

Two terminals:

```sh
npm run dev       # terminal 1: API on http://localhost:3000 (restarts on save)
npm run dev:web   # terminal 2: React app on http://localhost:5173 (hot reload)
```

Open **http://localhost:5173** and log in with a password from `.credentials.local`. Vite forwards every `/api/*` request to the API on port 3000.

```mermaid
flowchart LR
    B["Browser<br/>localhost:5173"] -->|"page, JS"| V["Vite dev server<br/>:5173"]
    V -->|"/api/* proxy"| E["Express API<br/>:3000"]
    E --> DB[("Postgres")]
    E --> O["OpenAI"]
```

### Production mode (exactly what Prisma runs)

```sh
npm run build   # type-checks, compiles the server to dist/, builds React into dist/public
npm start       # node dist/server.js on http://localhost:3000
```

Open **http://localhost:3000**. Rebuild after every change.

> Both modes use the database and OpenAI key in `.env`, so local questions hit real data and cost a fraction of a cent each.

---

## 12. Deploying on Prisma

The app runs on **Prisma Compute** with a **Prisma Postgres** database, declared in code:

- [`module.ts`](module.ts): provisions the database (applying `migrations/` before the app starts) and the `api` service, and binds the settings to environment variables.
- [`service.ts`](service.ts): the service build (`dist/`, with `node_modules` dependencies traced) and its typed settings.
- [`lib/config.ts`](lib/config.ts): on Prisma, the app reads its database from `service.load()` and its settings from `service.input()`; locally it reads `.env`.

### One-time: environment variables on Prisma

The database is provided by Prisma; the other settings must be added to the project (from your shell, so values never appear on screen):

```sh
set -a; source .env; set +a
for ROLE in production preview; do
  npx prisma project env add OPENAI_API_KEY  --role $ROLE --project capstone-project
  npx prisma project env add OPENAI_BASE_URL --role $ROLE --project capstone-project
  npx prisma project env add APP_USERS       --role $ROLE --project capstone-project
  npx prisma project env add SESSION_SECRET  --role $ROLE --project capstone-project
done
```

Check with `npx prisma project env list --role production --project capstone-project` (names only, never values).

### Deploying

Deploys run from GitHub Actions ([`.github/workflows/prisma-deploy.yml`](.github/workflows/prisma-deploy.yml)) through the repository's connection to the Prisma project:

```mermaid
flowchart LR
    Push["git push"] --> GH["GitHub Actions<br/>npm ci · npm run build"]
    GH --> Deploy["prisma deploy module.ts"]
    Deploy --> Mig["apply migrations/"]
    Mig --> Run["start the api service"]
    Push -. "main" .-> Prod["production"]
    Push -. "any other branch" .-> Prev["preview (own empty database)"]
```

- **`main`** deploys to production.
- **Any other branch** gets a preview with its own empty database (the app runs, but has no manuals until seeded). Deleting the branch removes the preview.
- After a deploy, the first request can take 10–15 s (cold start); send a warm-up request before a demo.

Useful commands:

```sh
npx prisma service list --project capstone-project                # URLs per branch
npx prisma service logs api --project capstone-project --tail 100 # server logs
npx prisma migration status                                       # applied migrations
```

---

## 13. API reference

All endpoints are under `/api` and take/return JSON. Everything except login needs the session cookie.

### `POST /api/login`

```json
{ "username": "user", "password": "…" }
```

`200 { "username": "user", "role": "user" }` with a `Set-Cookie: session=…`. `401` wrong credentials · `429` too many attempts · `503` login not configured.

### `POST /api/logout` · `GET /api/me`

Logout clears the cookie. `/api/me` returns the logged-in user or `401`.

### `POST /api/chat`

The whole conversation, newest message last (1–30 messages, each ≤ 4,000 characters):

```json
{ "messages": [
  { "role": "user", "content": "I want to pair my phone with my car" },
  { "role": "assistant", "content": "What model year and Acura model do you have?" },
  { "role": "user", "content": "It's a 2024 ZDX" }
] }
```

```json
{
  "reply": "1. Make sure Bluetooth is enabled on your phone… (2024 ZDX Owner's Manual, p. 136)",
  "sources": [
    { "manual": "2024 ZDX Owner's Manual", "docCode": "B36T2424OMEN", "page": 136,
      "section": "Infotainment System › Bluetooth (Overview)…",
      "url": "https://techinfo.honda.com/…/B36T2424OMEN.PDF#page=136" }
  ],
  "steps": [{ "tool": "search_manuals", "args": { "query": "…on a 2024 ZDX" }, "status": "ok" }]
}
```

### `POST /api/search`

The raw search, without the agent: `{ "query": "tire pressure on a 2026 MDX", "k": 5 }` (k 1–20).

| Status | When |
|---|---|
| `200` | Results: `vehicle`, `manuals`, `results[]` (rank, manual, page, section, content, distance, url); a `note` when no year was given |
| `422` | The query doesn't name a model (or names several): `missing`, `message`, `available` |
| `404` | No manuals for that year and model |

### From a terminal

```sh
U=http://localhost:3000            # or the production URL
read -s "PW?Password for user: "; echo
curl -s -c cookies.txt -X POST $U/api/login -H "Content-Type: application/json" \
  -d "{\"username\":\"user\",\"password\":\"$PW\"}"; unset PW
curl -s -b cookies.txt -X POST $U/api/chat -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What tire pressure should I use on my 2026 MDX?"}]}'
rm cookies.txt
```

---

## 14. Configuration reference

### Environment variables

| Variable | Required | Where | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | `.env`, Prisma (secret) | Embeddings and the agent |
| `OPENAI_BASE_URL` | no | `.env`, Prisma | OpenAI-compatible proxy; omit for api.openai.com |
| `OPENAI_CHAT_MODEL` | no | `.env` | Overrides the agent model (default `gpt-6-luna`; `gpt-6-sol` also works) |
| `DATABASE_URL` | local only | `.env` | Postgres for local runs and scripts (on Prisma the database comes from the service) |
| `APP_USERS` | yes | `.env`, Prisma (secret) | Accounts: `username:role:scrypt-hash`, comma-separated |
| `SESSION_SECRET` | yes | `.env`, Prisma (secret) | Signs session cookies |
| `PORT` | no | `.env` | Local port (default 3000; Prisma sets it) |

### Tuning constants

| Constant | File | Value |
|---|---|---|
| Chat model, temperature | `agents/manual-assistant.ts` | `gpt-6-luna`, 0.2 |
| History sent to the model | `agents/manual-assistant.ts` (`HISTORY_MESSAGES`) | 5 messages |
| Tool rounds per message | `agents/manual-assistant.ts` (`MAX_TOOL_ROUNDS`) | 5 |
| Passages per search | `agents/manual-assistant.ts` (`DEFAULT_K`) | 5 (max 10) |
| Scope rules and fixed replies | `agents/manual-assistant.ts` (`fewShotExamples`, `DEALER_NOTICE`) | see section 6 |
| Embedding model and size | `lib/openai.ts` | `text-embedding-3-small`, 1,536 |
| Usage limits | `lib/limits.ts` | 20/user/hour, 300/day, 10 logins/IP/15 min |
| Session length | `lib/auth.ts` | 7 days |
| Chunk sizes | `scripts/manuals/chunk.ts` | split above 700 tokens, target 500 |

> Changing the embedding model or size means a migration (the `vector(1536)` column) and re-uploading every manual.

---

## 15. npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | API with auto-restart (`tsx watch server.ts`), port 3000 |
| `npm run dev:web` | React dev server with hot reload, port 5173, `/api` proxied to 3000 |
| `npm run build` | Type-check and compile the server to `dist/`, type-check and build React into `dist/public` |
| `npm start` | Run the built app (`node dist/server.js`) |
| `npm run typecheck` | Type-check server and frontend |
| `npm run auth:users` | Create the `user` and `admin` accounts (`-- --force` to replace) |
| `npm run db:seed` | Fill vehicles, manuals and links from the manifests |
| `npm run manuals:chunk` | Chunk the PDFs into `data/chunks/` (`-- <DOC_CODE> --show <pages>` to inspect) |
| `npm run manuals:upload` | Embed and store chunks (`-- --dry-run`, `-- --force`, `-- <DOC_CODE>`) |
| `npm run contract:emit` | Regenerate `src/prisma/contract.json`/`.d.ts` after editing the schema |

Schema changes: edit `src/prisma/contract.prisma` → `npm run contract:emit` → `npx prisma migration plan --from <last migration> --name <name>` → commit `migrations/`.

---

## 16. Testing the main scenarios

Log in and try these; each shows a different part of the system.

| Scenario | Ask | Expected |
|---|---|---|
| Complete question | "What is the engine oil capacity for the 3.0 L engine on a 2026 MDX?" | 5.2 US qt, or 5.5 US qt (5.2 L) with the filter (p. 752) |
| Clarification | "How do I pair my phone with my car?" → "It's a 2024 ZDX" | Asks for the car, then gives the ZDX pairing steps (pp. 136–137) |
| Follow-up | "What tire pressure should I use on my 2026 MDX?" → "And how much oil does the 3.0 L engine take?" | 35 psi…, then 5.2 / 5.5 US qt |
| Switching cars | "…my 2026 Integra?" → "How do I check the tire pressure on my MDX?" | Asks for the MDX's year |
| Not in the manual | "How much does an oil change cost at the dealer for my 2026 MDX?" | Says the manual doesn't list prices; suggests a dealer |
| Off-topic | "What is the capital of Ecuador?" | "Please ask a question about Acura cars." |
| Repair | "My 2024 RDX makes a grinding noise when I brake, how do I fix it?" | The fixed "We never advise on fixing the car yourself…" reply |
| Dealer notice | "How do I change the engine oil on my 2026 MDX?" | The appointment recommendation, then the manual's steps |
| Unknown year | "How do I pair my phone with my 2027 MDX?" | No 2027 manual; offers 2022–2026 |

---

## 17. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `503 … not configured` | Missing `DATABASE_URL`, `OPENAI_API_KEY`, `APP_USERS` or `SESSION_SECRET` (locally in `.env`; on Prisma as project env vars). |
| `401 Please log in` | No or expired session; log in again. Cookies from `localhost:5173` and `:3000` are separate. |
| `429 …limit…` | Usage limit reached; wait (see `Retry-After`) or restart the server locally to reset the counters. |
| Deploy fails early naming a variable | That setting isn't defined on Prisma for the branch's role (production/preview). Add it with `prisma project env add`. |
| Deploy "succeeds" but skipped | The repository isn't connected to the Prisma project (Prisma Console → Git). |
| `502` right after a deploy | The server crashed on start; read `npx prisma service logs api`. |
| First answer after a deploy takes 10–15 s | Cold start; later requests take 2–5 s. |
| `contract emit` fails with codec errors | Mismatched Prisma package versions; reinstall the pinned set (see Setup). |
| `prisma migration plan` asks for an origin | Pass `--from <last migration directory name>`. |
| Port 3000 already in use | Stop the other process, or `PORT=3001 npm run dev` (then the Vite proxy needs 3000 free). |

---

## 18. Known limitations

- **Coverage:** US manuals, model years 2022–2026; no interactive (HTML) manuals.
- **Vehicle detection** needs the model name and a year ("2026" or "'26"); typos or nicknames make the assistant ask.
- **Extraction:** some illustration callouts and table cells come out in an unusual order; values stay inside their own table.
- **Limits and sessions** are per server process (in memory); a restart resets the counters.
- **No streaming:** answers appear when complete (typically 2–5 s).
- **Accounts** are managed with `npm run auth:users`, not in the UI.

---

## 19. Further documentation

| Document | Topic |
|---|---|
| [scripts/manuals/CHUNKING.md](scripts/manuals/CHUNKING.md) | The chunking strategy in detail |
| [scripts/manuals/UPLOADING.md](scripts/manuals/UPLOADING.md) | The embedding uploader |
| [scripts/db/schema.md](scripts/db/schema.md) | Tables, columns and example queries |
| [prisma-8.md](prisma-8.md) | Prisma ORM 8 quick reference |
