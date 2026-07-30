# SQL Management

Side-by-side SQL client for **MSSQL** and **PostgreSQL**. Originally built for migration validation; now used for daily querying with per-table query persistence, query history, schema browser, connection profiles, and result comparison.

---

## Features

- **Two panels** — MSSQL on the left, PostgreSQL on the right. Run queries independently or together.
- **Connection profiles** — save multiple connections per side (e.g. Dev / SIT / PROD), switch with one click.
- **🔒 Read-only profiles** — mark a profile read-only and the server blocks all `INSERT/UPDATE/DELETE/DROP/...`.
- **Destructive query guard** — confirmation prompt for `DROP`, `TRUNCATE`, and `DELETE`/`UPDATE` without `WHERE`.
- **Query cancel** — abort long-running queries from the UI (sends `pg_cancel_backend` / mssql `request.cancel`).
- **Schema browser** — expand any table in the sidebar to see its columns + types; click a column to insert it at the cursor.
- **Per-table query memory** — clicking a table restores the last query you ran against it.
- **Query history** — last 20 successful queries per side, with timestamp, row count, and runtime.
- **CSV export** — copy or download any result set.
- **Side-by-side comparison** — map columns between MSSQL and PostgreSQL results, highlight row-level differences.
- **Toast notifications**, **Ctrl+Enter** to run, render-cap on huge result sets.

---

## Setup

```powershell
# 1. Install dependencies
npm install

# 2. Copy the env template and fill in your defaults
cp .env.example .env
# (edit .env — at minimum set MSSQL_SERVER / PG_HOST / passwords)

# 3. Start the server
node server.js
# or: npm start
```

Open http://localhost:3000

> **Note:** Each user should run their own `node server.js` locally — the server holds connection state globally, so it is single-tenant by design.

---

## Configuration (.env)

```env
MSSQL_SERVER=localhost
MSSQL_USER=sa
MSSQL_PASSWORD=
MSSQL_TRUST_SERVER_CERT=true   # set false in prod
MSSQL_ENCRYPT=false            # set true for cloud SQL Server

PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=

# Optional: pre-select a database in each panel on first load
MSSQL_DEFAULT_DB=
PG_DEFAULT_DB=

HOST=127.0.0.1            # default; set 0.0.0.0 to expose on LAN (see Safety notes)
PORT=3000
QUERY_TIMEOUT_MS=60000    # hard cap per query (default 60s)
```

These are only the **startup defaults**. Once running, use the **⚙ Connection settings** button in each panel to switch servers/credentials at any time, and tick **Save as profile** to remember them. Profiles live in your browser's `localStorage` and are not shared.

---

## Connection profiles

Each profile stores: name, host/server, user, password, **and a read-only flag**.

- **Add a profile** — click ⚙, enter creds, tick **Save as profile**, give it a name (e.g. `SIT`), click Connect.
- **Switch profiles** — click the profile name button in the panel header (it's a toggle).
- **Read-only profiles** display with a **🔒** prefix and yellow border. The server rejects any non-`SELECT` query when active.

Recommendation: create a `🔒 PROD` profile for production read access and a regular `Dev` profile for everything else.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Enter` | Run current query |
| Click a table | Auto-generate `SELECT TOP 1000` / `LIMIT 1000` (with `ORDER BY id DESC` if an `id` column exists) and run |
| Click a saved table | Restore the last query you ran against it |

---

## Architecture (for hacking on it)

Two files matter:

- **`server.js`** — Express. Routes: `/api/{mssql,pg}/{databases,tables,columns,query,connect,cancel}`, `/api/status`. Connection state is module-global (`mssqlConfig`, `pgConfig`, plus `mssqlReadOnly`/`pgReadOnly` flags).
- **`public/index.html`** — single-file SPA, ~2500 lines, no build step, all JS/CSS inline. CodeMirror 5 for the editors.

State persistence:
- localStorage: `msProfiles`, `pgProfiles`, `queryHistory:{ms,pg}`, `dbq:{side}:{db}` (per-table queries), `collapsedSchemas:{ms,pg}`, `sidebarCollapsed:{ms,pg}`, `lastMode`.

---

## Safety notes

- **No auth.** The API has no authentication. By default the server binds to `127.0.0.1` so only your machine can reach it. Only set `HOST=0.0.0.0` on a trusted network — anyone who can reach the port can run queries with whatever credentials the server is configured with.
- The destructive-query guard is **client-side** — it can be bypassed if someone calls the API directly. The **read-only profile flag is server-enforced** and is the actual safety boundary for production access.
- Both safeguards use comment/string-literal-aware regex to avoid false positives (e.g. `'DELETE'` inside a string literal is ignored).
- Hard query timeout is set on both pools (`requestTimeout` for mssql, `statement_timeout` for pg) to protect against runaway queries.
- `MSSQL_TRUST_SERVER_CERT=true` (the default) skips TLS verification — fine for local dev, set `false` against production.

## Audit log

Every query is appended as one JSON line to `logs/audit-YYYY-MM-DD.log`, including timestamp, workstation hostname, OS user, side (`ms`/`pg`), database, client IP, status (`ok`/`error`), duration, and the query text (truncated past `AUDIT_QUERY_MAX`, default 4000 chars). The `logs/` directory is gitignored. Delete or rotate it however you like — the server only ever appends.
