# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview

**SQL Management** — a web-based SQL management tool supporting SQL Server (MSSQL) and PostgreSQL. Handles day-to-day querying with connection profiles, read-only profile enforcement, query history, schema browser, CSV/JSON export, column stats, query snippets, resizable result columns, find-in-results, row counts, paste-as-VALUES, and an optional split-view mode for side-by-side work across both connections.

## Commands

```powershell
# Install dependencies
npm install

# Copy env template (first time only)
cp .env.example .env

# Start the server (http://localhost:3000)
node server.js
# or: npm start
```

No build step, no test suite — single-file Express app serving a single static HTML page.

## Architecture

**Two files matter:**

- `server.js` — Express backend. Loads `.env` manually (no `dotenv` dep). Connection state is **per browser session**, not global: `attachSession` (mounted on `/api`) resolves a `sqlmgmt_sid` cookie to a session record holding the four fixed slots (`ms`/`pg`/`ms2`/`pg2`) plus that browser's added panels. Handlers reach them via `req.conns.<slot>` and `req.session.conns`. No authentication — sessions separate people's connections, they do not authorise anyone.
- `public/index.html` — single-page app, all JS/CSS inline, CodeMirror 5 for editors, no framework. ~6200 lines.

**Env vars** (loaded from `.env`, see `.env.example` for full list): `HOST` (default `127.0.0.1` — bind address), `PORT` (default 3000), `MSSQL_SERVER`/`MSSQL_USER`/`MSSQL_PASSWORD`, `MSSQL_TRUST_SERVER_CERT` (default `true`), `MSSQL_ENCRYPT` (default `false`), `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_PASSWORD`, `MSSQL_DEFAULT_DB`/`PG_DEFAULT_DB` (auto-select on first load), `QUERY_TIMEOUT_MS` (default 60000), `SESSION_TTL_MS` (default 8h — how long an idle browser session keeps its pooled connections).

**Backend endpoints** (`/api/{mssql,pg}/...`):
- `connect`, `disconnect` (pg only) — switch credentials at runtime
- `databases`, `tables`, `columns` — schema browsing
- `query` returns `{ results: [{statement, columns, rows, rowsAffected, durationMs}], error }`; `cancel`, `ping` — execution + abort + healthcheck
- `/api/status` — combined connection state

**Safety layers:**
- Read-only profile flag is **server-enforced** (rejects non-`SELECT`). This is the real safety boundary.
- Client-side destructive-query confirmation for `DROP`/`TRUNCATE`/unscoped `DELETE`/`UPDATE` (advisory only — bypassable by direct API calls).
- Hard query timeout (`QUERY_TIMEOUT_MS`, default 60s) on both pools.
- Audit log written to `logs/audit-YYYY-MM-DD.log` per query.
- Each browser gets its own connections. Switching server/profile, a read-only
  profile, and Cancel all affect only the browser that issued them. This is
  isolation between people sharing one server, **not** authentication — anyone
  who can reach the API gets a session and the `.env` credentials with it.

**Frontend state (localStorage):** `msProfiles`, `pgProfiles`, `queryHistory:{ms,pg}`, `collapsedSchemas:{ms,pg}`, `sidebarCollapsed:{ms,pg}`, `lastMode`, `theme` (`dark`/`light`/`system`), `lastDb:ms:<server>:<user>` and `lastDb:pg:<host>:<port>:<user>` (per-profile last-selected DB), `sqlSnippets` (query snippet library).

## UI Layout

The app has three view modes toggled from the header:
- **SQL Server** — shows only the left (SQL Server / MSSQL) panel
- **Split View** — shows both panels side-by-side
- **PostgreSQL** — shows only the right (PostgreSQL) panel

Each panel has a sidebar (table browser) and a main query area with tabs.

## Key Behaviors to Know

- Clicking a table always generates a fresh `SELECT TOP 1000` (SQL Server) or `LIMIT 1000` (PostgreSQL) in the editor and executes it immediately. Appends `ORDER BY <id> DESC` if a column named `id` (case-insensitive) exists in the cached schema.
- **Run Both** (Split View mode) executes both panels and enables the comparison panel. Comparison can match rows positionally or by key column value; differences highlighted in red.
- Read-only profiles render with `🔒` prefix and yellow border.
- Server binds to `127.0.0.1` by default (no auth on the API). Set `HOST=0.0.0.0` only on a trusted network.
- `SIGINT`/`SIGTERM` close SQL Server and PG pools gracefully before exit.
- Frontend resolves DB selection priority on load: last-used (per profile, in localStorage) → `*_DEFAULT_DB` env → first DB in list. The defaults come from `/api/status`, not hard-coded.
- Theme toggle is in the header (`🌙`/`☀️`/`🖥️`). System mode listens to `prefers-color-scheme` changes live.
- Multi-statement batches are supported: the server splits on top-level `;` (quote/comment-aware via `splitStatements`) and returns `{ results: [...], error }` with one entry per statement. The UI stacks each statement's result top-to-bottom.
- **SQL Server**: each user statement is run as `SET IMPLICIT_TRANSACTIONS OFF; SET XACT_ABORT ON; <stmt>` in a single `sp_executesql` call so the session fixup lands on the same pooled connection as the statement. No server-side `BEGIN TRAN`/`COMMIT TRAN` wrapper — that was unreliable across pool connections and caused Msg 266 ("Transaction count after EXECUTE…") on servers with `IMPLICIT_TRANSACTIONS` on. For multi-statement atomicity, write explicit `BEGIN TRAN`/`COMMIT TRAN` inside a single statement.
- **PostgreSQL**: the batch is wrapped in a single transaction; on a mid-batch error the transaction is rolled back. HTTP response is `200` with a non-null `error` and any results captured before the failure (status 499 only when explicitly cancelled).
- Comparison ("Run Both") uses the **last** result set with columns on each side. If a side has no result set with columns (e.g., a batch ending in `UPDATE`), comparison is blocked with a toast.
- Caveat: PG batches beginning with an explicit `BEGIN` / `START TRANSACTION` nest inside the server's wrapper and PG warns. For explicit PG transaction control, run single statements.

## Features Reference

| Feature | How it works |
|---|---|
| **Query tabs** | Per-panel tabs with auto-save by DB. `tabsState[side]`, `scheduleAutoSave`. |
| **Query history** | Stored in `localStorage` under `queryHistory:{ms,pg}`. |
| **Snippets** | Saved in `localStorage` under `sqlSnippets`. `toggleSnippets`, `addSnippet`, `insertSnippet`. |
| **Find in results** | `applyGlobalFilter(side, q)` — filters all columns, stored in `viewState[id].globalFilter`. |
| **Column stats** | Click σ icon on any header → `showColStats()` shows min/max/distinct/null popup. |
| **Resizable columns** | Drag column border → `startColResize()`. Widths stored in `colWidths` map per container. |
| **Copy row as INSERT** | Right-click row → `_buildInsertFromRow()`. Quotes identifiers per dialect. |
| **Edit row/cell → UPDATE, Delete row → DELETE** | Right-click a result cell. Target table comes from the result block's own statement, parsed at render time (`_parseBaseTable` → `viewState[subId]._sourceTable`) — never from the sidebar selection (`activeTableKey`). Only single-base-table SELECTs are editable (JOINs, subqueries, comma FROM-lists, views, CTEs are rejected). WHERE is scoped by PK (`fetchPk`, `/pk` endpoint), falling back to identifier-ish columns (`_pickIdentifierCols`), then all columns — each with a warning comment. Generated SQL is inserted into the editor for review, never auto-executed. |
| **CSV / JSON export** | `resultsToCSV`, `resultsToJSON`, `copyCSV`, `downloadCSV`, `copyJSON`, `downloadJSON`. |
| **Row counts** | `# Counts` button → `loadRowCounts(side)`. Fetches `COUNT(*)` in batches of 5, stores in `tableRowCounts[side]` (Map). SQL Server uses `WITH (NOLOCK)`. |
| **Column search** | Sidebar search matches table names, schema names, and cached column names (`colCache`). |
| **Paste as VALUES** | TSV paste detected via `_looksLikeTSV` → banner offers `convertPasteToValues`. |
| **Schema diff** | `openSchemaDiff()` fetches both sides' table lists; `renderSchemaDiffView()` shows only-left / only-right / both. |
| **Decompress** | `tryDecompressString` — base64 gzip/deflate (e.g. SQL Server CompressorHelper blobs). |
| **Compare tool** | Side-by-side text diff with inline word-level highlighting. |

## Critical Implementation Note

`public/index.html` is ~6200 lines. **Never use the Edit tool for large block replacements on this file** — it truncates the file. Always use Python scripts via Bash (`mcp__workspace__bash`) for any replacement that touches more than ~20 lines at once.
